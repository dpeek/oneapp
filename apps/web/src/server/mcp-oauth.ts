import { linksReadScope, linksWriteScope } from "@orumai/core/links";
import { OAuthScope, OAuthServer } from "@yielded/auth";
import { OAuthServerPersistence } from "@yielded/auth-persistence";
import { Clock, Effect, Layer, Redacted, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { SqlClient } from "effect/sql";
import {
  codexClientId,
  codexMetadataOrigin,
  isCodexMetadataId,
  McpGrant,
  McpGrantId,
  McpGrantList,
  mcpGrantsPath,
  mcpLoginPath,
  mcpLoginQuery,
  tasksReadScope,
  tasksWriteScope,
} from "../mcp-access-contract.ts";
import { jsonError, privateHeaders } from "./api-response.ts";
import {
  AppAuth,
  CryptoLive,
  sessionCookieName,
  type authHttp,
} from "./auth.ts";
import { McpConsentRenderer } from "./mcp-consent.ts";

export const ReadLinks = OAuthScope.make(linksReadScope);
export const WriteLinks = OAuthScope.make(linksWriteScope);
export const ReadTasks = OAuthScope.make(tasksReadScope);
export const WriteTasks = OAuthScope.make(tasksWriteScope);
export const mcpScopes = [
  ReadLinks,
  WriteLinks,
  ReadTasks,
  WriteTasks,
] as const;
export type McpScope = (typeof mcpScopes)[number];
export const mcpOAuth = OAuthServer.make("mcp", {
  scopes: mcpScopes,
});
const codexClient = {
  clientId: codexClientId,
  name: "Codex",
  applicationType: "native",
  grantTypes: ["authorization_code", "refresh_token"],
} as const;

const fetchCodexMetadata = (...[input, init]: Parameters<typeof fetch>) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!isCodexMetadataId(url))
    return Promise.reject(new Error("Unsupported OAuth client metadata URL"));
  return fetch(input, { ...init, credentials: "omit", redirect: "manual" });
};

const BrowserIdentity = Layer.effect(
  mcpOAuth.Identity,
  Effect.gen(function* () {
    const auth = yield* AppAuth;
    return {
      current: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const cookie = request.cookies[sessionCookieName];
        if (cookie === undefined) return undefined;
        return yield* auth.verifySession(Redacted.make(cookie)).pipe(
          Effect.map((session) => session.subjectId),
          Effect.catchTag("SessionInvalid", () => Effect.succeed(undefined)),
          Effect.mapError(() => OAuthServer.Unavailable.make({})),
        );
      }),
    };
  }),
);

export const mcpOAuthLayer = (
  origin: string,
  secret: Redacted.Redacted<string>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const resource = `${origin}/mcp`;
      // Codex versions that use a per-server callback suffix derive it from the resource URL.
      const digest = yield* Effect.promise(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(resource)),
      );
      const callback = "http://127.0.0.1/callback";
      const callbackId = Base64Url.encode(new Uint8Array(digest)).slice(0, 12);
      return mcpOAuth.layer({
        origin,
        resource,
        loginPath: mcpLoginPath,
        clientMetadata: { allowedOrigins: [codexMetadataOrigin] },
        clients: [
          {
            ...codexClient,
            redirectUris: [callback, `${callback}/${callbackId}`],
          },
        ],
        keys: {
          activeKeyId: "oneapp-mcp",
          keys: [{ id: "oneapp-mcp", material: secret }],
        },
      });
    }),
  ).pipe(
    Layer.provide(BrowserIdentity),
    Layer.provide(McpConsentRenderer),
    Layer.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(
          Layer.succeed(
            FetchHttpClient.Fetch,
            fetchCodexMetadata as typeof fetch,
          ),
        ),
      ),
    ),
    Layer.provide(OAuthServerPersistence.layer),
    Layer.provide(CryptoLive),
  );

export const mcpLoginRoute = HttpRouter.add(
  "GET",
  mcpLoginPath,
  HttpServerResponse.redirect(`/?${mcpLoginQuery}=1`, {
    headers: privateHeaders,
  }),
);

const owner = Effect.flatMap(AppAuth, (auth) => auth.requireSession);
const authRequired = () => jsonError(401, "Sign in required");
// Yielded Auth sets a 30-day grant expiry on MCP code redemption and keeps it on refresh.
const mcpGrantLifetimeMillis = 30 * 86_400_000;

export const mcpGrantRoutes = (
  http: ReturnType<typeof authHttp>,
  origin: string,
) => {
  const namespace = `${origin}${mcpOAuth.paths.authorize.replace(/\/authorize$/u, "")}`;
  const isGrantId = Schema.is(McpGrantId);
  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      mcpGrantsPath,
      Effect.gen(function* () {
        const session = yield* owner;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* Clock.currentTimeMillis;
        const grants = yield* sql<typeof McpGrant.Type>`
        SELECT grant_id AS id, json_extract(payload, '$.authorization.clientId') AS "clientId",
               expires_at_millis - ${mcpGrantLifetimeMillis} AS "createdAt",
               expires_at_millis AS "expiresAt"
        FROM yielded_oauth_server
        WHERE namespace = ${namespace} AND revoked = 0 AND expires_at_millis > ${now}
          AND json_extract(payload, '$.status') = 'Active'
          AND json_extract(payload, '$.subjectId') = ${session.subjectId}
          AND json_array_length(payload, '$.authorization.scopes') > 0
          AND NOT EXISTS (
            SELECT 1 FROM json_each(payload, '$.authorization.scopes')
            WHERE value NOT IN (SELECT value FROM json_each(${JSON.stringify(mcpScopes)}))
          )
        ORDER BY expires_at_millis DESC, grant_id
      `;
        return yield* HttpServerResponse.schemaJson(McpGrantList)(grants, {
          headers: privateHeaders,
        });
      }).pipe(Effect.catchTag("AuthenticationRequired", authRequired)),
    ),
    HttpRouter.add(
      "DELETE",
      `${mcpGrantsPath}/:id`,
      Effect.gen(function* () {
        const session = yield* owner;
        return yield* http.protect(
          Effect.gen(function* () {
            const { id } = yield* HttpRouter.params;
            if (!isGrantId(id))
              return yield* jsonError(400, "Invalid MCP grant ID");
            const sql = yield* SqlClient.SqlClient;
            const [grant] = yield* sql<{ id: string }>`
          SELECT grant_id AS id FROM yielded_oauth_server
          WHERE namespace = ${namespace} AND grant_id = ${id}
            AND json_extract(payload, '$.status') = 'Active'
            AND json_extract(payload, '$.subjectId') = ${session.subjectId}
        `;
            if (grant) {
              const oauth = yield* mcpOAuth.Service;
              yield* oauth.revoke(grant.id);
            }
            return HttpServerResponse.empty({
              status: 204,
              headers: privateHeaders,
            });
          }),
        );
      }).pipe(
        Effect.catchTags({
          AuthenticationRequired: authRequired,
          HookDenied: () => jsonError(403, "Request not allowed"),
          OAuthServerUnavailable: () =>
            jsonError(503, "Could not revoke MCP access"),
        }),
      ),
    ),
  );
};
