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
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/signIn" && request.method === "POST") {
      const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
      if (!(await env.AUTH_LIMIT.limit({ key })).success) {
        return Response.json(
          { error: "Too many sign-in attempts" },
          { status: 429 },
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
        Layer.mergeAll(
          me,
          linksRoutes(http),
          cliTokenRoutes(http),
          cliLoginRoutes(http),
          extensionAccessRoutes(http),
        ).pipe(http.middleware),
        http.routes(),
      ).pipe(
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
