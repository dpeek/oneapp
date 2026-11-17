import {
  CliToken,
  CliTokenList,
  CliTokenSecret,
  CreateCliToken,
  IssuedCliToken,
  cliTokensPath,
  currentCliTokenPath,
} from "@oneapp/core/cli-auth";
import { ByteSize, Clock, Data, Effect, Layer, Schema } from "effect";
import { Base64Url, Hex } from "effect/encoding";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { jsonError, privateHeaders } from "./api-response.ts";
import { AppAuth, type authHttp } from "./auth.ts";

const isTokenSecret = Schema.is(CliTokenSecret);
export const digestToken = Effect.fnUntraced(function* (secret: string) {
  const bytes = new TextEncoder().encode(secret);
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", bytes),
  );
  return Hex.encode(new Uint8Array(digest));
});

export class InvalidCliToken extends Data.TaggedError("InvalidCliToken")<{}> {}

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
    typeof CliToken.Type & { ownerId: string; canDelete: number }
  >`
    SELECT t.id, t.owner_id AS "ownerId", t.label, t.created_at AS "createdAt",
           t.expires_at AS "expiresAt", t.can_delete AS "canDelete"
    FROM cli_tokens t JOIN accounts a ON a.id = t.owner_id
    WHERE t.digest = ${digest} AND (t.expires_at IS NULL OR t.expires_at > ${now}) AND a.active = 1
  `;
  if (!token) return yield* new InvalidCliToken();
  return token;
});

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
      "POST",
      cliTokensPath,
      Effect.gen(function* () {
        const session = yield* owner;
        return yield* http.protect(
          Effect.gen(function* () {
            const input = yield* HttpServerRequest.schemaBodyJson(
              CreateCliToken,
            ).pipe(
              Effect.provideService(
                HttpServerRequest.MaxBodySize,
                ByteSize.kibibytes(2),
              ),
              Effect.option,
            );
            if (input._tag === "None")
              return yield* jsonError(
                400,
                "Enter a name of 1 to 60 characters",
              );

            const secret = `one_${Base64Url.encode(crypto.getRandomValues(new Uint8Array(32)))}`;
            const digest = yield* digestToken(secret);
            const createdAt = yield* Clock.currentTimeMillis;
            const token = {
              id: crypto.randomUUID(),
              label: input.value.label,
              createdAt,
              expiresAt: null,
            };
            const sql = yield* SqlClient.SqlClient;
            yield* sql`
          INSERT INTO cli_tokens (id, owner_id, label, digest, created_at, expires_at, can_delete)
          VALUES (${token.id}, ${session.subjectId}, ${token.label}, ${digest}, ${token.createdAt}, ${token.expiresAt}, ${input.value.allowDelete === true ? 1 : 0})
        `;
            return yield* HttpServerResponse.schemaJson(IssuedCliToken)(
              { token, secret },
              { status: 201, headers: privateHeaders },
            );
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
