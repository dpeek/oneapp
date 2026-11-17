import {
  CliToken,
  CliTokenList,
  CliTokenSecret,
  cliTokensPath,
  currentCliTokenPath,
} from "@oneapp/core/cli-auth";
import { LinkScope } from "@oneapp/core/links";
import { Clock, Data, Effect, Layer, Schema } from "effect";
import { Hex } from "effect/encoding";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { jsonError, privateHeaders } from "./api-response.ts";
import { AppAuth, type authHttp } from "./auth.ts";

const isTokenSecret = Schema.is(CliTokenSecret);
const decodeScopes = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(LinkScope)),
);
const digestToken = Effect.fnUntraced(function* (secret: string) {
  const bytes = new TextEncoder().encode(secret);
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", bytes),
  );
  return Hex.encode(new Uint8Array(digest));
});

export class InvalidCliToken extends Data.TaggedError("InvalidCliToken")<{}> {}
class InsufficientCliScope extends Data.TaggedError("InsufficientCliScope")<{
  scope: typeof LinkScope.Type;
}> {}

export const requireCliDigest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const secret = /^Bearer (\S+)$/iu.exec(
    request.headers.authorization ?? "",
  )?.[1];
  if (!isTokenSecret(secret)) return yield* new InvalidCliToken();

  return yield* digestToken(secret);
});

export const requireCliToken = Effect.gen(function* () {
  const digest = yield* requireCliDigest;
  const now = yield* Clock.currentTimeMillis;
  const sql = yield* SqlClient.SqlClient;
  const [token] = yield* sql<
    typeof CliToken.Type & { ownerId: string; scopes: string }
  >`
    SELECT t.id, t.owner_id AS "ownerId", t.label, t.created_at AS "createdAt",
           t.expires_at AS "expiresAt", t.scopes
    FROM cli_tokens t JOIN accounts a ON a.id = t.owner_id
    WHERE t.digest = ${digest} AND (t.expires_at IS NULL OR t.expires_at > ${now}) AND a.active = 1
  `;
  if (!token) return yield* new InvalidCliToken();
  return token;
});

export const requireCliScope = Effect.fnUntraced(function* (
  scope: typeof LinkScope.Type,
) {
  const token = yield* requireCliToken;
  const scopes = decodeScopes(token.scopes);
  if (scopes._tag === "None" || !scopes.value.includes(scope))
    return yield* new InsufficientCliScope({ scope });
  return token;
});

export const insufficientCliScopeResponse = ({ scope }: InsufficientCliScope) =>
  jsonError(403, `CLI token requires ${scope}. Run one auth login again.`);

export const invalidTokenResponse = () =>
  jsonError(401, "CLI token is invalid, expired, or revoked");

export const cliTokenRoutes = (http: ReturnType<typeof authHttp>) => {
  const owner = Effect.flatMap(AppAuth, (auth) => auth.requireSession);
  const authRequired = () => jsonError(401, "Sign in required");
  const denied = () => jsonError(403, "Request not allowed");

  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      cliTokensPath,
      Effect.gen(function* () {
        const session = yield* owner;
        const now = yield* Clock.currentTimeMillis;
        const sql = yield* SqlClient.SqlClient;
        const tokens = yield* sql<typeof CliToken.Type>`
        SELECT id, label, created_at AS "createdAt", expires_at AS "expiresAt"
        FROM cli_tokens
        WHERE owner_id = ${session.subjectId} AND (expires_at IS NULL OR expires_at > ${now})
        ORDER BY created_at DESC, id DESC
      `;
        return yield* HttpServerResponse.schemaJson(CliTokenList)(tokens, {
          headers: privateHeaders,
        });
      }).pipe(Effect.catchTag("AuthenticationRequired", authRequired)),
    ),
    HttpRouter.add(
      "DELETE",
      `${cliTokensPath}/:id`,
      Effect.gen(function* () {
        const session = yield* owner;
        return yield* http.protect(
          Effect.gen(function* () {
            const { id } = yield* HttpRouter.params;
            if (!id) return yield* jsonError(400, "Token ID is required");
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DELETE FROM cli_tokens WHERE id = ${id} AND owner_id = ${session.subjectId}`;
            return HttpServerResponse.empty({
              status: 204,
              headers: privateHeaders,
            });
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
      currentCliTokenPath,
      requireCliToken.pipe(
        Effect.flatMap((token) =>
          HttpServerResponse.schemaJson(CliToken)(token, {
            headers: privateHeaders,
          }),
        ),
        Effect.catchTag("InvalidCliToken", invalidTokenResponse),
      ),
    ),
    HttpRouter.add(
      "DELETE",
      currentCliTokenPath,
      Effect.gen(function* () {
        const token = yield* requireCliToken;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM cli_tokens WHERE id = ${token.id} AND owner_id = ${token.ownerId}`;
        return HttpServerResponse.empty({
          status: 204,
          headers: privateHeaders,
        });
      }).pipe(Effect.catchTag("InvalidCliToken", invalidTokenResponse)),
    ),
  );
};
