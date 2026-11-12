import { Link, LinkList, SaveLink, linksPath } from "@oneapp/core/links";
import { ByteSize, Clock, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { jsonError, privateHeaders } from "./api-response.ts";
import { AppAuth, type authHttp } from "./auth.ts";
import { invalidTokenResponse, requireCliToken } from "./cli-tokens.ts";
import {
  invalidExtensionResponse,
  requireExtensionToken,
} from "./extension-access.ts";

const linkOwner = (allowExtension: boolean) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.authorization !== undefined) {
      const token =
        allowExtension &&
        /^Bearer one_ext_/iu.test(request.headers.authorization)
          ? yield* requireExtensionToken
          : yield* requireCliToken;
      return { id: token.ownerId, browserSession: false };
    }

    const auth = yield* AppAuth;
    const session = yield* auth.requireSession;
    return { id: session.subjectId, browserSession: true };
  });

const authRequired = () => jsonError(401, "Sign in required");

const listLinks = Effect.gen(function* () {
  const owner = yield* linkOwner(false);
  const sql = yield* SqlClient.SqlClient;
  const links = yield* sql<typeof Link.Type>`
    SELECT id, url, saved_at AS "savedAt"
    FROM links
    WHERE owner_id = ${owner.id}
    ORDER BY saved_at DESC, id DESC
  `;
  return yield* HttpServerResponse.schemaJson(LinkList)(links, {
    headers: privateHeaders,
  });
}).pipe(
  Effect.catchTags({
    AuthenticationRequired: authRequired,
    InvalidCliToken: invalidTokenResponse,
    InvalidExtensionToken: invalidExtensionResponse,
  }),
);

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

  const link = {
    id: crypto.randomUUID(),
    url: input.value.url,
    savedAt: yield* Clock.currentTimeMillis,
  };
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO links (id, owner_id, url, saved_at)
    VALUES (${link.id}, ${ownerId}, ${link.url}, ${link.savedAt})
  `;
  return yield* HttpServerResponse.schemaJson(Link)(link, {
    status: 201,
    headers: privateHeaders,
  });
});

export const linksRoutes = (http: ReturnType<typeof authHttp>) =>
  Layer.mergeAll(
    HttpRouter.add("GET", linksPath, listLinks),
    HttpRouter.add(
      "POST",
      linksPath,
      Effect.gen(function* () {
        const owner = yield* linkOwner(true);
        const save = saveLink(owner.id);
        return yield* owner.browserSession ? http.protect(save) : save;
      }).pipe(
        Effect.catchTags({
          AuthenticationRequired: authRequired,
          HookDenied: () => jsonError(403, "Request not allowed"),
          InvalidCliToken: invalidTokenResponse,
          InvalidExtensionToken: invalidExtensionResponse,
        }),
      ),
    ),
  );
