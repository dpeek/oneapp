import {
  EmailDelivery,
  Password,
  Schema as AuthSchema,
  Sessions,
} from "@yielded/auth";
import {
  ProofBinding,
  ProofRequestContext,
  ProofRequestId,
} from "@yielded/auth/Proofs";
import { ByteSize, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import {
  CompletePasswordReset,
  passwordResetPath,
  RequestPasswordReset,
  resetPasswordPage,
} from "../password-recovery-contract.ts";
import { jsonError, privateHeaders } from "./api-response.ts";
import { AppAuth, type authHttp } from "./auth.ts";
import { newPasswordRejectionMessage } from "./password-policy.ts";

// Yielded builds the bearer fragment. Set the deployed landing origin here
// because the password strategy is shared with owner provisioning.
export const resetLinkRenderer = (origin: string) =>
  Layer.succeed(EmailDelivery.EmailRenderer, {
    render: (message) => {
      const renderer = EmailDelivery.EmailRenderer.defaultValue();
      if (
        message.purpose !== "password-reset" ||
        message.content._tag !== "Link"
      ) {
        return renderer.render(message);
      }

      const target = new URL(resetPasswordPage, origin);
      target.hash = new URL(Redacted.value(message.content.url)).hash;
      return renderer.render({
        ...message,
        content: { _tag: "Link", url: Redacted.make(target.href) },
      });
    },
  });

const storedBinding = Schema.decodeUnknownOption(
  Schema.fromJsonString(ProofBinding),
);
const noContent = () =>
  HttpServerResponse.empty({ status: 204, headers: privateHeaders });
const notAllowed = () => jsonError(403, "Request not allowed");
const invalidLink = () =>
  jsonError(400, "This reset link is invalid or expired. Request a new link.");
const resetUnavailable = () =>
  jsonError(503, "Could not reset your password. Try again shortly.");

export const passwordRecoveryRoutes = (
  http: ReturnType<typeof authHttp>,
  deliveryEnabled: boolean,
) =>
  Layer.mergeAll(
    HttpRouter.add(
      "POST",
      passwordResetPath,
      http
        .protect(
          Effect.gen(function* () {
            const input = yield* HttpServerRequest.schemaBodyJson(
              RequestPasswordReset,
            ).pipe(
              Effect.provideService(
                HttpServerRequest.MaxBodySize,
                ByteSize.kibibytes(2),
              ),
              Effect.option,
            );
            if (Option.isNone(input))
              return yield* jsonError(400, "Enter a valid email address");
            if (!deliveryEnabled) return noContent();
            const auth = yield* AppAuth;
            const request = yield* HttpServerRequest.HttpServerRequest;
            yield* auth
              .requestReset({
                email: input.value.email,
                flowId: Sessions.AuthenticationFlowId.make(crypto.randomUUID()),
                requestId: ProofRequestId.make(crypto.randomUUID()),
                locale: AuthSchema.Locale.make("en"),
              })
              .pipe(
                Effect.provideService(
                  ProofRequestContext,
                  Effect.succeed({
                    networkKey: Redacted.make(
                      request.headers["cf-connecting-ip"] ?? "local",
                    ),
                  }),
                ),
                Effect.catch(() =>
                  Effect.logWarning("Could not issue password reset link"),
                ),
              );
            return noContent();
          }),
        )
        .pipe(Effect.catchTag("HookDenied", notAllowed)),
    ),
    HttpRouter.add(
      "POST",
      `${passwordResetPath}/complete`,
      http
        .protect(
          Effect.gen(function* () {
            const input = yield* HttpServerRequest.schemaBodyJson(
              CompletePasswordReset,
            ).pipe(
              Effect.provideService(
                HttpServerRequest.MaxBodySize,
                ByteSize.kibibytes(26),
              ),
              Effect.option,
            );
            if (Option.isNone(input)) return yield* invalidLink();
            const { reference, secret, newPassword } = input.value;
            if (reference.purpose !== "password-reset")
              return yield* invalidLink();

            // The reference is only disclosed in the email. Look up the original
            // flow server-side so a reset link can be opened on another device.
            const sql = yield* SqlClient.SqlClient;
            const [proof] = yield* sql<{ binding: string }>`
        SELECT binding FROM oneapp_auth_proofs
        WHERE module_id = ${AppAuth.strategies.password.persistence.moduleId + "/reset"}
          AND purpose = ${reference.purpose}
          AND proof_id = ${reference.proofId}
          AND verifier_key_id = ${reference.keyId}
          AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      `;
            const binding = storedBinding(proof?.binding);
            if (
              Option.isNone(binding) ||
              binding.value._tag !== "Subject" ||
              binding.value.identifier.namespace !== "email"
            ) {
              return yield* invalidLink();
            }

            const auth = yield* AppAuth;
            yield* auth.completeReset({
              email: binding.value.identifier.value,
              flowId: binding.value.flowId,
              commandId: Password.PasswordCommandId.make(crypto.randomUUID()),
              reference,
              secret: Redacted.value(secret),
              newPassword: Redacted.value(newPassword),
            });
            return noContent();
          }),
        )
        .pipe(
          Effect.catchTags({
            HookDenied: notAllowed,
            PasswordRejected: invalidLink,
            PasswordActionRequired: invalidLink,
            NewPasswordRejected: ({ reason }) =>
              jsonError(400, newPasswordRejectionMessage(reason)),
            PasswordCheckUnavailable: () =>
              jsonError(
                503,
                "Password screening is unavailable. Try again shortly.",
              ),
            PasswordUnavailable: resetUnavailable,
            SqlError: resetUnavailable,
          }),
        ),
    ),
  );
