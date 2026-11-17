import {
  Link,
  LinkId,
  LinkList,
  type LinkScope,
  SaveLink,
  linksPath,
  linksReadScope,
  linksWriteScope,
} from "@oneapp/core/links";
import { ByteSize, Clock, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { jsonError, privateHeaders } from "./api-response.ts";
import { AppAuth, type authHttp } from "./auth.ts";
import {
  insufficientCliScopeResponse,
  invalidTokenResponse,
  requireCliScope,
} from "./cli-tokens.ts";
import {
  invalidExtensionResponse,
  requireExtensionToken,
} from "./extension-access.ts";

const linkOwner = (scope: typeof LinkScope.Type, allowExtension = false) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.authorization !== undefined) {
      const token =
        allowExtension &&
        /^Bearer one_ext_/iu.test(request.headers.authorization)
          ? yield* requireExtensionToken
          : yield* requireCliScope(scope);
      return { id: token.ownerId, browserSession: false };
    }

    const auth = yield* AppAuth;
    const session = yield* auth.requireSession;
    return { id: session.subjectId, browserSession: true };
  });

const authRequired = () => jsonError(401, "Sign in required");

export const listSavedLinks = Effect.fnUntraced(function* (
  ownerId: string,
  limit = -1,
  offset = 0,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<typeof Link.Type>`
    SELECT id, url, saved_at AS "savedAt"
    FROM links
    WHERE owner_id = ${ownerId}
    ORDER BY saved_at DESC, id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
});

const listLinks = Effect.gen(function* () {
  const owner = yield* linkOwner(linksReadScope);
  const links = yield* listSavedLinks(owner.id);
  return yield* HttpServerResponse.schemaJson(LinkList)(links, {
    headers: privateHeaders,
  });
}).pipe(
  Effect.catchTags({
    AuthenticationRequired: authRequired,
    InvalidCliToken: invalidTokenResponse,
    InsufficientCliScope: insufficientCliScopeResponse,
    InvalidExtensionToken: invalidExtensionResponse,
  }),
);

export const insertSavedLink = Effect.fnUntraced(function* (
  ownerId: string,
  url: typeof SaveLink.Type.url,
) {
  const link = {
    id: crypto.randomUUID(),
    url,
    savedAt: yield* Clock.currentTimeMillis,
  };
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO links (id, owner_id, url, saved_at)
    VALUES (${link.id}, ${ownerId}, ${link.url}, ${link.savedAt})
  `;
  return link;
});

const saveLink = Effect.fnUntraced(function* (ownerId: string) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const contentType = request.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json")
    return yield* jsonError(415, "Expected a JSON request");

  const input = yield* HttpServerRequest.schemaBodyJson(SaveLink).pipe(
    Effect.provideService(
      HttpServerRequest.MaxBodySize,
      ByteSize.kibibytes(16),
    ),
    Effect.option,
  );
  if (input._tag === "None")
    return yield* jsonError(
      400,
      "Enter a valid HTTP or HTTPS URL without credentials",
    );

  const link = yield* insertSavedLink(ownerId, input.value.url);
  return yield* HttpServerResponse.schemaJson(Link)(link, {
    status: 201,
    headers: privateHeaders,
  });
});

export const deleteSavedLink = Effect.fnUntraced(function* (
  ownerId: string,
  id: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    DELETE FROM links WHERE owner_id = ${ownerId} AND id = ${id}
    RETURNING id
  `;
  return rows.length > 0;
});

const deleteLink = Effect.fnUntraced(function* (ownerId: string) {
  const { id } = yield* HttpRouter.params;
  if (!Schema.is(LinkId)(id)) return yield* jsonError(400, "Invalid link ID");
  if (!(yield* deleteSavedLink(ownerId, id)))
    return yield* jsonError(404, "Link not found");
  return HttpServerResponse.empty({ status: 204, headers: privateHeaders });
});

export const linksRoutes = (http: ReturnType<typeof authHttp>) =>
  Layer.mergeAll(
    HttpRouter.add("GET", linksPath, listLinks),
    HttpRouter.add(
      "DELETE",
      `${linksPath}/:id`,
      Effect.gen(function* () {
        const owner = yield* linkOwner(linksWriteScope);
        const remove = deleteLink(owner.id);
        return yield* owner.browserSession ? http.protect(remove) : remove;
      }).pipe(
        Effect.catchTags({
          AuthenticationRequired: authRequired,
          HookDenied: () => jsonError(403, "Request not allowed"),
          InvalidCliToken: invalidTokenResponse,
          InsufficientCliScope: insufficientCliScopeResponse,
          InvalidExtensionToken: invalidExtensionResponse,
        }),
      ),
    ),
    HttpRouter.add(
      "POST",
      linksPath,
      Effect.gen(function* () {
        const owner = yield* linkOwner(linksWriteScope, true);
        const save = saveLink(owner.id);
        return yield* owner.browserSession ? http.protect(save) : save;
      }).pipe(
        Effect.catchTags({
          AuthenticationRequired: authRequired,
          HookDenied: () => jsonError(403, "Request not allowed"),
          InvalidCliToken: invalidTokenResponse,
          InsufficientCliScope: insufficientCliScopeResponse,
          InvalidExtensionToken: invalidExtensionResponse,
        }),
      ),
    ),
  );
