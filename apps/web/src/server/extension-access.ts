import {
  currentExtensionPath,
  digestSecret,
  ExtensionAccess,
  ExtensionAccessList,
  ExtensionApproval,
  extensionAccessPath,
  ExtensionRequestId,
  ExtensionSecret,
} from "@oneapp/core/extension-auth";
import { ByteSize, Clock, Data, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { jsonError, privateHeaders } from "./api-response.ts";
import { AppAuth, type authHttp } from "./auth.ts";

const isSecret = Schema.is(ExtensionSecret);
const isRequestId = Schema.is(ExtensionRequestId);

class InvalidExtensionToken extends Data.TaggedError(
  "InvalidExtensionToken",
)<{}> {}

export const invalidExtensionResponse = () =>
  jsonError(401, "Extension access is invalid, expired, or revoked");

export const requireExtensionToken = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const secret = /^Bearer (\S+)$/iu.exec(
    request.headers.authorization ?? "",
  )?.[1];
  if (!isSecret(secret)) return yield* new InvalidExtensionToken();

  const digest = yield* Effect.promise(() => digestSecret(secret));
  const now = yield* Clock.currentTimeMillis;
  const sql = yield* SqlClient.SqlClient;
  const [token] = yield* sql<typeof ExtensionAccess.Type & { ownerId: string }>`
    SELECT t.id, t.owner_id AS "ownerId", t.created_at AS "createdAt", t.expires_at AS "expiresAt"
    FROM extension_tokens t JOIN accounts a ON a.id = t.owner_id
    WHERE t.digest = ${digest} AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > ${now}) AND a.active = 1
  `;
  if (!token) return yield* new InvalidExtensionToken();
  return token;
});

const owner = Effect.flatMap(AppAuth, (auth) => auth.requireSession);
const authRequired = () => jsonError(401, "Sign in required");
const denied = () => jsonError(403, "Request not allowed");
const noContent = () =>
  HttpServerResponse.empty({ status: 204, headers: privateHeaders });

export const extensionAccessRoutes = (http: ReturnType<typeof authHttp>) =>
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      extensionAccessPath,
      Effect.gen(function* () {
        const session = yield* owner;
        const now = yield* Clock.currentTimeMillis;
        const sql = yield* SqlClient.SqlClient;
        const tokens = yield* sql<typeof ExtensionAccess.Type>`
          SELECT id, created_at AS "createdAt", expires_at AS "expiresAt"
          FROM extension_tokens
          WHERE owner_id = ${session.subjectId} AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ${now})
          ORDER BY created_at DESC, id DESC
        `;
        return yield* HttpServerResponse.schemaJson(ExtensionAccessList)(
          tokens,
          { headers: privateHeaders },
        );
      }).pipe(Effect.catchTag("AuthenticationRequired", authRequired)),
    ),
    HttpRouter.add(
      "POST",
      extensionAccessPath,
      Effect.gen(function* () {
        const session = yield* owner;
        return yield* http.protect(
          Effect.gen(function* () {
            const input = yield* HttpServerRequest.schemaBodyJson(
              ExtensionApproval,
            ).pipe(
              Effect.provideService(
                HttpServerRequest.MaxBodySize,
                ByteSize.kibibytes(2),
              ),
              Effect.option,
            );
            if (input._tag === "None")
              return yield* jsonError(400, "Invalid extension request");
            const { id, digest } = input.value;
            const now = yield* Clock.currentTimeMillis;
            const sql = yield* SqlClient.SqlClient;
            const [token] = yield* sql<{ id: string }>`
            INSERT INTO extension_tokens (id, owner_id, digest, created_at)
            VALUES (${id}, ${session.subjectId}, ${digest}, ${now})
            ON CONFLICT DO NOTHING RETURNING id
          `;
            if (!token)
              return yield* jsonError(
                409,
                "This extension request has already been used",
              );
            return noContent();
          }),
        );
      }).pipe(
        Effect.catchTags({
          AuthenticationRequired: authRequired,
          HookDenied: denied,
        }),
      ),
    ),
    HttpRouter.add(
      "DELETE",
      `${extensionAccessPath}/:id`,
      Effect.gen(function* () {
        const session = yield* owner;
        return yield* http.protect(
          Effect.gen(function* () {
            const { id } = yield* HttpRouter.params;
            if (!isRequestId(id))
              return yield* jsonError(400, "Invalid extension ID");
            const now = yield* Clock.currentTimeMillis;
            const sql = yield* SqlClient.SqlClient;
            yield* sql`
            UPDATE extension_tokens SET revoked_at = ${now}
            WHERE id = ${id} AND owner_id = ${session.subjectId} AND revoked_at IS NULL
          `;
            return noContent();
          }),
        );
      }).pipe(
        Effect.catchTags({
          AuthenticationRequired: authRequired,
          HookDenied: denied,
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      currentExtensionPath,
      requireExtensionToken.pipe(
        Effect.as(noContent()),
        Effect.catchTag("InvalidExtensionToken", invalidExtensionResponse),
      ),
    ),
    HttpRouter.add(
      "DELETE",
      currentExtensionPath,
      Effect.gen(function* () {
        const token = yield* requireExtensionToken;
        const now = yield* Clock.currentTimeMillis;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          UPDATE extension_tokens SET revoked_at = ${now}
          WHERE id = ${token.id} AND revoked_at IS NULL
        `;
        return noContent();
      }).pipe(
        Effect.catchTag("InvalidExtensionToken", invalidExtensionResponse),
      ),
    ),
  );
