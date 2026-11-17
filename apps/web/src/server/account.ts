import {
  Auth,
  Email,
  EmailDelivery,
  Operations,
  Password,
  Schema as AuthSchema,
} from "@yielded/auth";
import { ProofRequestContext, ProofRequestId } from "@yielded/auth/Proofs";
import { appName } from "@oneapp/core";
import { ByteSize, Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import {
  ChangePassword,
  EmailVerification,
  emailVerificationPath,
  passwordChangePath,
  VerifyEmail,
} from "../account-contract.ts";
import { Account } from "../auth-contract.ts";
import { jsonError, privateHeaders } from "./api-response.ts";
import { AppAuth, type authHttp } from "./auth.ts";
import { newPasswordRejectionMessage } from "./password-policy.ts";

const noContent = () =>
  HttpServerResponse.empty({ status: 204, headers: privateHeaders });
const sessionRequired = () => jsonError(401, "Sign in required");
const notAllowed = () => jsonError(403, "Request not allowed");
const readAccount = Effect.fnUntraced(function* (
  subjectId: string,
  email: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [identifier] = yield* sql<{ verified_at: number | null }>`
    SELECT verified_at FROM oneapp_auth_identifiers
    WHERE subject_id = ${subjectId} AND namespace = 'email'
      AND value = ${email} AND active = 1
  `;
  return identifier;
});

export const accountRoutes = (
  http: ReturnType<typeof authHttp>,
  email: {
    enabled: boolean;
    accepted: () => boolean;
    limit: (input: { key: string }) => Promise<{ success: boolean }>;
  },
) =>
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/api/me",
      Effect.gen(function* () {
        const auth = yield* AppAuth;
        const session = yield* auth.requireSession;
        const identifier = yield* readAccount(
          session.subjectId,
          session.claims.email,
        );
        return yield* HttpServerResponse.schemaJson(Account)(
          {
            id: Account.fields.id.make(session.subjectId),
            email: session.claims.email,
            emailVerified: identifier?.verified_at != null,
            emailDeliveryEnabled: email.enabled,
          },
          { headers: privateHeaders },
        );
      }).pipe(Effect.catchTag("AuthenticationRequired", sessionRequired)),
    ),
    HttpRouter.add(
      "POST",
      emailVerificationPath,
      http
        .protect(
          Effect.gen(function* () {
            const auth = yield* AppAuth;
            const session = yield* auth.requireSession;
            const address = AuthSchema.Email.make(session.claims.email);
            const identifier = yield* readAccount(session.subjectId, address);
            if (!identifier) return yield* notAllowed();
            if (identifier.verified_at !== null) return noContent();
            if (!email.enabled)
              return yield* jsonError(503, "Email sending is unavailable");
            const admitted = yield* Effect.promise(() =>
              email.limit({ key: session.subjectId }),
            );
            if (!admitted.success)
              return yield* jsonError(
                429,
                "Too many verification emails. Try again in a minute.",
              );

            const request = yield* Auth.AuthRequest;
            const flowId = Operations.RequestBindingFlowId.make(
              crypto.randomUUID(),
            );
            let binding:
              | Extract<Operations.AuthCredentialCommand, { _tag: "Issue" }>
              | undefined;
            yield* auth.beginEmailAddress("email", { flowId }).pipe(
              Effect.provideService(Auth.AuthRequest, {
                ...request,
                credentialCommandSink: (commands) =>
                  Effect.sync(() => {
                    for (const command of commands) {
                      if (
                        command._tag === "Issue" &&
                        command.slot === "request-binding"
                      )
                        binding = command;
                    }
                  }),
              }),
            );
            if (!binding)
              return yield* jsonError(
                503,
                "Could not start email verification",
              );

            const incoming = yield* HttpServerRequest.HttpServerRequest;
            const { reference } = yield* auth
              .requestEmailVerification("email", {
                flowId,
                requestBinding: Redacted.value(binding.credential),
                commandId: Email.EmailCommandId.make(
                  `${session.sessionId}:${flowId}`,
                ),
                email: address,
                requestId: ProofRequestId.make(crypto.randomUUID()),
                locale: AuthSchema.Locale.make("en"),
              })
              .pipe(
                Effect.provideService(
                  ProofRequestContext,
                  Effect.succeed({
                    networkKey: Redacted.make(
                      incoming.headers["cf-connecting-ip"] ?? "local",
                    ),
                  }),
                ),
              );
            if (!email.accepted())
              return yield* jsonError(
                503,
                "Could not send a code. Try again shortly.",
              );
            yield* request.credentialCommandSink([binding]);
            return yield* HttpServerResponse.schemaJson(EmailVerification)(
              { flowId, reference },
              { headers: privateHeaders },
            );
          }),
        )
        .pipe(
          Effect.catchTags({
            AuthenticationRequired: sessionRequired,
            HookDenied: notAllowed,
            EmailRejected: notAllowed,
            EmailActionRequired: notAllowed,
            EmailUnavailable: () =>
              jsonError(503, "Could not send a code. Try again shortly."),
          }),
        ),
    ),
    HttpRouter.add(
      "POST",
      `${emailVerificationPath}/confirm`,
      http
        .protect(
          Effect.gen(function* () {
            const auth = yield* AppAuth;
            const session = yield* auth.requireSession;
            const request = yield* Auth.AuthRequest;
            const requestBinding = request.credentials["request-binding"];
            if (!requestBinding)
              return yield* jsonError(400, "Request a new verification code");

            const input = yield* HttpServerRequest.schemaBodyJson(
              VerifyEmail,
            ).pipe(
              Effect.provideService(
                HttpServerRequest.MaxBodySize,
                ByteSize.kibibytes(2),
              ),
              Effect.option,
            );
            if (input._tag === "None")
              return yield* jsonError(400, "Enter the six-digit code");
            const { code, flowId, reference } = input.value;
            yield* auth.completeEmailVerification("email", {
              commandId: Email.EmailCommandId.make(
                `${session.sessionId}:${flowId}`,
              ),
              flowId,
              reference,
              requestBinding: Redacted.value(requestBinding),
              secret: Redacted.value(code),
              email: AuthSchema.Email.make(session.claims.email),
            });
            return noContent();
          }),
        )
        .pipe(
          Effect.catchTags({
            AuthenticationRequired: sessionRequired,
            HookDenied: notAllowed,
            EmailActionRequired: notAllowed,
            EmailRejected: () =>
              jsonError(
                400,
                "Code is incorrect or expired. Try again or request a new code.",
              ),
            EmailUnavailable: () =>
              jsonError(503, "Could not verify email. Try again shortly."),
          }),
        ),
    ),
    HttpRouter.add(
      "POST",
      passwordChangePath,
      http
        .protect(
          Effect.gen(function* () {
            const auth = yield* AppAuth;
            const session = yield* auth.requireSession;
            const input = yield* HttpServerRequest.schemaBodyJson(
              ChangePassword,
            ).pipe(
              Effect.provideService(
                HttpServerRequest.MaxBodySize,
                ByteSize.kibibytes(24),
              ),
              Effect.option,
            );
            if (input._tag === "None")
              return yield* jsonError(
                400,
                "Enter your current and new passwords",
              );
            const { currentPassword, newPassword } = input.value;
            if (
              Redacted.value(currentPassword).normalize("NFC") ===
              Redacted.value(newPassword).normalize("NFC")
            )
              return yield* jsonError(400, "Choose a different new password");

            const address = AuthSchema.Email.make(session.claims.email);
            const identifier = yield* readAccount(session.subjectId, address);
            yield* auth.changePassword({
              commandId: Password.PasswordCommandId.make(crypto.randomUUID()),
              currentPassword: Redacted.value(currentPassword),
              newPassword: Redacted.value(newPassword),
            });
            if (email.enabled && identifier?.verified_at != null) {
              const delivery = yield* EmailDelivery.EmailDelivery;
              yield* delivery
                .send({
                  to: address,
                  subject: `Your ${appName} password changed`,
                  text: Redacted.make(
                    `Your ${appName} password was changed and your browser sessions were signed out. If this wasn't you, contact your OneApp administrator.`,
                  ),
                })
                .pipe(
                  Effect.catch(() =>
                    Effect.logWarning(
                      "Could not send password change notification",
                    ),
                  ),
                );
            }
            return noContent();
          }),
        )
        .pipe(
          Effect.catchTags({
            AuthenticationRequired: sessionRequired,
            HookDenied: notAllowed,
            PasswordActionRequired: notAllowed,
            PasswordRejected: () =>
              jsonError(400, "Could not verify your current password"),
            NewPasswordRejected: ({ reason }) =>
              jsonError(400, newPasswordRejectionMessage(reason)),
            PasswordCheckUnavailable: () =>
              jsonError(
                503,
                "Password screening is unavailable. Try again shortly.",
              ),
            PasswordUnavailable: () =>
              jsonError(
                503,
                "Could not change your password. Try again shortly.",
              ),
          }),
        ),
    ),
  );
