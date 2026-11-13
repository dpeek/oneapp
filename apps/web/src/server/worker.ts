import type { WorkerEnv } from "../../../../alchemy.run.ts";
import { cliLoginPath } from "@oneapp/core/cli-auth";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { Account } from "../auth-contract.ts";
import { AppAuth, authHttp } from "./auth.ts";
import { cliLoginRoutes } from "./cli-login.ts";
import { cliTokenRoutes } from "./cli-tokens.ts";
import { authDependencies, databaseLayer } from "./database.ts";
import { extensionAccessRoutes } from "./extension-access.ts";
import { linksRoutes } from "./links.ts";
import { mcpRoutes } from "./mcp.ts";
import {
  mcpGrantRoutes,
  mcpLoginRoute,
  mcpOAuth,
  mcpOAuthLayer,
} from "./mcp-oauth.ts";

const health = HttpRouter.add(
  "GET",
  "/api/health",
  HttpServerResponse.json({ ok: true }),
);

const me = HttpRouter.add(
  "GET",
  "/api/me",
  Effect.gen(function* () {
    const auth = yield* AppAuth;
    const session = yield* auth.requireSession;
    return yield* HttpServerResponse.json({
      id: Account.fields.id.make(session.subjectId),
      email: session.claims.email,
    });
  }).pipe(
    Effect.catchTag("AuthenticationRequired", () =>
      HttpServerResponse.json({ error: "Sign in required" }, { status: 401 }),
    ),
    Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")),
  ),
);

export default {
  async fetch(request: Request, env: WorkerEnv) {
    const url = new URL(request.url);
    const path = url.pathname;
    const signingIn = path === "/api/auth/signIn" && request.method === "POST";
    const oauthRequest =
      (path === mcpOAuth.paths.authorize &&
        url.searchParams.has("response_type")) ||
      ([mcpOAuth.paths.token, mcpOAuth.paths.revoke].some(
        (route) => route === path,
      ) &&
        request.method === "POST");
    if (signingIn || oauthRequest) {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const key = signingIn ? ip : `mcp-oauth:${ip}`;
      if (!(await env.AUTH_LIMIT.limit({ key })).success) {
        return Response.json(
          {
            error: signingIn
              ? "Too many sign-in attempts"
              : "Too many OAuth requests",
          },
          {
            status: 429,
            headers: { "cache-control": "no-store", "retry-after": "10" },
          },
        );
      }
    }
    if (
      request.method === "POST" &&
      (path === cliLoginPath ||
        (path.startsWith(cliLoginPath + "/") && path.endsWith("/poll")))
    ) {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const action = path === cliLoginPath ? "start" : "poll";
      if (
        !(await env.CLI_LOGIN_LIMIT.limit({ key: `${action}:${ip}` })).success
      ) {
        return Response.json(
          { error: "Too many CLI login requests" },
          {
            status: 429,
            headers: { "cache-control": "no-store", "retry-after": "10" },
          },
        );
      }
    }

    const http = authHttp(env.APP_ORIGIN);
    const database = databaseLayer(env.DB);
    const dependencies = authDependencies(
      database,
      Redacted.make(env.AUTH_SECRET),
    );
    const app = HttpRouter.toWebHandler(
      Layer.mergeAll(
        health,
        mcpOAuth.routes,
        mcpLoginRoute,
        mcpRoutes(env.APP_ORIGIN),
        Layer.mergeAll(
          me,
          linksRoutes(http),
          cliTokenRoutes(http),
          cliLoginRoutes(http),
          extensionAccessRoutes(http),
          mcpGrantRoutes(http, env.APP_ORIGIN),
        ).pipe(http.middleware),
        http.routes(),
      ).pipe(
        Layer.provideMerge(
          mcpOAuthLayer(
            env.APP_ORIGIN,
            Redacted.make(env.MCP_OAUTH_SECRET),
          ).pipe(Layer.provide(database)),
        ),
        Layer.provide(http.layer.pipe(Layer.provide(dependencies))),
        HttpRouter.provideRequest(database),
        Layer.provide(HttpServer.layerServices),
      ),
      {
        disableLogger: true,
      },
    );

    try {
      return await app.handler(request);
    } finally {
      await app.dispose();
    }
  },
};
