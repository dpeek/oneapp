import { ByteSize, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  pushPath,
  PushEndpointInput,
  PushSubscriptionInput,
} from "../push-contract.ts";
import { AppAuth, type authHttp } from "./auth.ts";
import { jsonError, privateHeaders } from "./api-response.ts";
import {
  defaultMailboxId,
  ensureDefaultMailbox,
  requireMailbox,
} from "./mailbox.ts";
import { pushConfiguration, type PushEnv } from "./push-delivery.ts";

export const pushRoutes = (http: ReturnType<typeof authHttp>, env: PushEnv) => {
  const owner = Effect.gen(function* () {
    const auth = yield* AppAuth;
    const session = yield* auth.requireSession;
    yield* Effect.tryPromise(async () => {
      await ensureDefaultMailbox(env.DB);
      await requireMailbox(env.DB, defaultMailboxId, session.subjectId);
    });
    return session;
  });
  const endpointBody = HttpServerRequest.schemaBodyJson(PushEndpointInput).pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.kibibytes(4)),
    Effect.option,
  );
  const handle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catch((error) => {
        const tag =
          typeof error === "object" && error !== null && "_tag" in error
            ? error._tag
            : null;
        return tag === "AuthenticationRequired"
          ? jsonError(401, "Sign in required")
          : tag === "HookDenied"
            ? jsonError(403, "Request not allowed")
            : jsonError(503, "Notifications are unavailable. Try again.");
      }),
    );
  const noContent = () =>
    HttpServerResponse.empty({ status: 204, headers: privateHeaders });
  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      pushPath,
      handle(
        Effect.gen(function* () {
          yield* owner;
          return yield* HttpServerResponse.json(
            { publicKey: pushConfiguration(env)?.publicKey ?? null },
            { headers: privateHeaders },
          );
        }),
      ),
    ),
    HttpRouter.add(
      "POST",
      `${pushPath}/status`,
      handle(
        http.protect(
          Effect.gen(function* () {
            const session = yield* owner;
            const input = yield* endpointBody;
            if (input._tag === "None")
              return yield* jsonError(400, "Invalid subscription");
            const row = yield* Effect.tryPromise(() =>
              env.DB.prepare(
                `SELECT id FROM push_subscriptions
        WHERE endpoint = ? AND account_id = ? AND mailbox_id = ? AND session_id = ? AND security_revision = ?`,
              )
                .bind(
                  input.value.endpoint,
                  session.subjectId,
                  defaultMailboxId,
                  session.sessionId,
                  session.securityRevision,
                )
                .first(),
            );
            return yield* HttpServerResponse.json(
              { enabled: Boolean(row) && Boolean(pushConfiguration(env)) },
              { headers: privateHeaders },
            );
          }),
        ),
      ),
    ),
    HttpRouter.add(
      "POST",
      `${pushPath}/subscription`,
      handle(
        http.protect(
          Effect.gen(function* () {
            const session = yield* owner;
            if (!pushConfiguration(env))
              return yield* jsonError(
                503,
                "Notifications are not configured on this deployment.",
              );
            const input = yield* HttpServerRequest.schemaBodyJson(
              PushSubscriptionInput,
            ).pipe(
              Effect.provideService(
                HttpServerRequest.MaxBodySize,
                ByteSize.kibibytes(4),
              ),
              Effect.option,
            );
            if (input._tag === "None")
              return yield* jsonError(400, "Invalid subscription");
            const { endpoint, keys } = input.value;
            const publicKey = yield* Effect.tryPromise(() =>
              crypto.subtle.importKey(
                "raw",
                new Uint8Array(Buffer.from(keys.p256dh, "base64url")),
                { name: "ECDH", namedCurve: "P-256" },
                false,
                [],
              ),
            ).pipe(Effect.option);
            if (publicKey._tag === "None")
              return yield* jsonError(400, "Invalid subscription key");
            const db = env.DB;
            yield* Effect.tryPromise(() =>
              db.batch([
                // Re-enabling after signing in starts a new subscription lifetime and
                // discards pending jobs associated with the old session.
                db
                  .prepare(
                    "DELETE FROM push_subscriptions WHERE endpoint = ? AND account_id = ? AND session_id <> ?",
                  )
                  .bind(endpoint, session.subjectId, session.sessionId),
                db
                  .prepare(
                    `INSERT INTO push_subscriptions (id, account_id, mailbox_id, session_id, security_revision, endpoint, p256dh, auth, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
          WHERE push_subscriptions.account_id = excluded.account_id AND push_subscriptions.session_id = excluded.session_id`,
                  )
                  .bind(
                    crypto.randomUUID(),
                    session.subjectId,
                    defaultMailboxId,
                    session.sessionId,
                    session.securityRevision,
                    endpoint,
                    keys.p256dh,
                    keys.auth,
                    Date.now(),
                  ),
              ]),
            );
            return noContent();
          }),
        ),
      ),
    ),
    HttpRouter.add(
      "DELETE",
      `${pushPath}/subscription`,
      handle(
        http.protect(
          Effect.gen(function* () {
            const session = yield* owner;
            const input = yield* endpointBody;
            if (input._tag === "None")
              return yield* jsonError(400, "Invalid subscription");
            yield* Effect.tryPromise(() =>
              env.DB.prepare(
                "DELETE FROM push_subscriptions WHERE endpoint = ? AND account_id = ?",
              )
                .bind(input.value.endpoint, session.subjectId)
                .run(),
            );
            return noContent();
          }),
        ),
      ),
    ),
  );
};
