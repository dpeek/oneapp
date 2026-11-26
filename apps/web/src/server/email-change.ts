import { randomInt } from "node:crypto";
import { appName } from "@orumai/core";
import {
  Auth,
  EmailDelivery,
  Password,
  Schema as AuthSchema,
} from "@yielded/auth";
import { ByteSize, Effect, Layer, Option, Redacted } from "effect";
import { Base64Url } from "effect/encoding";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  ChangedEmail,
  ConfirmEmailChange,
  emailChangePath,
  PendingEmailChange,
  StartEmailChange,
} from "../account-contract.ts";
import { jsonError, privateHeaders } from "./api-response.ts";
import { AppAuth, type authHttp } from "./auth.ts";
import {
  commitEmailChange,
  discardEmailChange,
  saveEmailChange,
} from "./email-change-store.ts";

const codeDigest = (
  secret: Redacted.Redacted<string>,
  id: string,
  code: string,
) =>
  Effect.promise(async () => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(Redacted.value(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const payload = encoder.encode(
      JSON.stringify(["oneapp/email-change/v1", id, code]),
    );
    return Base64Url.encode(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, payload)),
    );
  });

const verifyPassword = Effect.fnUntraced(function* (
  session: {
    subjectId: AuthSchema.SubjectId;
    securityRevision: string;
    claims: { email: string };
  },
  password: Redacted.Redacted<string>,
) {
  const persistence = yield* Password.PasswordPersistence;
  const candidate = yield* persistence.readForSubject({
    moduleId: AppAuth.strategies.password.persistence.moduleId,
    subjectId: session.subjectId,
  });
  if (Option.isNone(candidate)) return false;
  const credential = candidate.value;
  if (
    credential.revision.securityRevision !== session.securityRevision ||
    credential.identifier.value !== session.claims.email
  )
    return false;
  const hashing = yield* Password.PasswordHashing;
  const normalized =
    credential.normalization === "NFC"
      ? Redacted.make(Redacted.value(password).normalize("NFC"))
      : password;
  return (yield* hashing.verify(normalized, credential.verifier)).matches;
});

export const emailChangeRoutes = (
  http: ReturnType<typeof authHttp>,
  secret: Redacted.Redacted<string>,
  deliveryEnabled: boolean,
  limit: (input: { key: string }) => Promise<{ success: boolean }>,
) =>
  Layer.mergeAll(
    HttpRouter.add(
      "POST",
      emailChangePath,
      http
        .protect(
          Effect.gen(function* () {
            const auth = yield* AppAuth;
            const session = yield* auth.requireSession;
            if (!deliveryEnabled)
              return yield* jsonError(503, "Email sending is unavailable");
            const input = yield* HttpServerRequest.schemaBodyJson(
              StartEmailChange,
            ).pipe(
              Effect.provideService(
                HttpServerRequest.MaxBodySize,
                ByteSize.kibibytes(26),
              ),
              Effect.option,
            );
            if (Option.isNone(input))
              return yield* jsonError(
                400,
                "Enter a valid new email and your current password",
              );
            const { email, currentPassword } = input.value;
            if (email === session.claims.email)
              return yield* jsonError(400, "Enter a different email address");
            const admitted = yield* Effect.promise(() =>
              limit({ key: `email-change:${session.subjectId}` }),
            );
            if (!admitted.success)
              return yield* jsonError(
                429,
                "Too many attempts. Try again in a minute.",
              );
            if (!(yield* verifyPassword(session, currentPassword)))
              return yield* jsonError(
                400,
                "Could not verify your current password",
              );

            const id = crypto.randomUUID();
            const code = String(randomInt(1_000_000)).padStart(6, "0");
            const digest = yield* codeDigest(secret, id, code);
            if (!(yield* saveEmailChange(session, { id, email, digest })))
              return yield* jsonError(
                409,
                "Could not start an email change for that address",
              );

            const delivery = yield* EmailDelivery.EmailDelivery;
            const sent = yield* delivery
              .send({
                to: email,
                subject: `Your ${appName} email change code`,
                text: Redacted.make(
                  `Your ${appName} verification code is ${code}. It expires in 5 minutes. If you did not request it, ignore this email.`,
                ),
              })
              .pipe(Effect.result);
            if (sent._tag === "Failure") {
              yield* discardEmailChange(session.subjectId, id);
              return yield* jsonError(
                503,
                "Could not send a code. Try again shortly.",
              );
            }
            return yield* HttpServerResponse.schemaJson(PendingEmailChange)(
              { id, email },
              { headers: privateHeaders },
            );
          }),
        )
        .pipe(
          Effect.catchTags({
            AuthenticationRequired: () => jsonError(401, "Sign in required"),
            HookDenied: () => jsonError(403, "Request not allowed"),
            PasswordInputInvalid: () =>
              jsonError(400, "Could not verify your current password"),
            PasswordUnavailable: () =>
              jsonError(
                503,
                "Could not check your password. Try again shortly.",
              ),
            PasswordKdfBusy: () =>
              jsonError(
                503,
                "Could not check your password. Try again shortly.",
              ),
            PasswordHashingUnavailable: () =>
              jsonError(
                503,
                "Could not check your password. Try again shortly.",
              ),
            PasswordVerifierInvalid: () =>
              jsonError(
                503,
                "Could not check your password. Try again shortly.",
              ),
            SqlError: () =>
              jsonError(
                503,
                "Could not start email change. Try again shortly.",
              ),
          }),
        ),
    ),
    HttpRouter.add(
      "POST",
      `${emailChangePath}/confirm`,
      http
        .protect(
          Effect.gen(function* () {
            const auth = yield* AppAuth;
            const session = yield* auth.requireSession;
            if (!deliveryEnabled)
              return yield* jsonError(503, "Email sending is unavailable");
            const input = yield* HttpServerRequest.schemaBodyJson(
              ConfirmEmailChange,
            ).pipe(
              Effect.provideService(
                HttpServerRequest.MaxBodySize,
                ByteSize.kibibytes(2),
              ),
              Effect.option,
            );
            if (Option.isNone(input))
              return yield* jsonError(400, "Enter the six-digit code");
            const { id, code } = input.value;
            const digest = yield* codeDigest(secret, id, Redacted.value(code));
            const oldEmail = AuthSchema.Email.make(session.claims.email);
            const updated = yield* commitEmailChange(session, {
              id,
              oldEmail,
              digest,
            });
            if (!updated)
              return yield* jsonError(
                400,
                "Code is incorrect, expired, or no longer active",
              );

            const request = yield* Auth.AuthRequest;
            yield* request.credentialCommandSink([
              { _tag: "Clear", slot: "session" },
              { _tag: "Clear", slot: "pending-proof" },
              { _tag: "Clear", slot: "request-binding" },
            ]);
            const delivery = yield* EmailDelivery.EmailDelivery;
            const notice = yield* delivery
              .send({
                to: oldEmail,
                subject: `Your ${appName} sign-in email changed`,
                text: Redacted.make(
                  `Your ${appName} sign-in email was changed and your browser sessions were signed out. If you did not make this change, contact your Orumai administrator.`,
                ),
              })
              .pipe(
                Effect.as(true),
                Effect.catch(() =>
                  Effect.logWarning(
                    "Could not send email change notification",
                  ).pipe(Effect.as(false)),
                ),
              );
            return yield* HttpServerResponse.schemaJson(ChangedEmail)(
              { oldAddressNotified: notice },
              { headers: privateHeaders },
            );
          }),
        )
        .pipe(
          Effect.catchTags({
            AuthenticationRequired: () => jsonError(401, "Sign in required"),
            HookDenied: () => jsonError(403, "Request not allowed"),
            SqlError: () =>
              jsonError(
                503,
                "Could not confirm email change. Check which address you can sign in with before retrying.",
              ),
          }),
        ),
    ),
  );
