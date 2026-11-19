import type { WorkerEnv } from "../../../../alchemy.run.ts";
import type { ForwardableEmailMessage } from "@cloudflare/workers-types";
import { cliLoginPath } from "@oneapp/core/cli-auth";
import { EmailDelivery } from "@yielded/auth";
import { ProofDispatchScheduler } from "@yielded/auth/Proofs";
import { Effect, Layer, Redacted } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { accountPath } from "../account-contract.ts";
import {
  forgotPasswordPage,
  passwordResetPath,
  resetPasswordPage,
} from "../password-recovery-contract.ts";
import { cloudflareEmail, disabledEmail } from "./account-email.ts";
import { accountRoutes } from "./account.ts";
import { AppAuth, authHttp, sessionCookieName } from "./auth.ts";
import { bitwardenDeviceRoutes } from "./bitwarden/devices.ts";
import { bitwardenIcon } from "./bitwarden/icons.ts";
import { bitwardenFetch, isBitwardenPath } from "./bitwarden/routes.ts";
import { privateHeaders } from "./api-response.ts";
import { cliLoginRoutes } from "./cli-login.ts";
import { cliTokenRoutes } from "./cli-tokens.ts";
import { authDependencies, databaseLayer } from "./database.ts";
import { emailChangeRoutes } from "./email-change.ts";
import { extensionAccessRoutes } from "./extension-access.ts";
import { inboxMessageKey, inboxRoutes, inboxSubject } from "./inbox.ts";
import { linksRoutes } from "./links.ts";
import { mcpRoutes } from "./mcp.ts";
import {
  mcpGrantRoutes,
  mcpLinkScopes,
  mcpLoginRoute,
  mcpOAuth,
  mcpOAuthLayer,
} from "./mcp-oauth.ts";
import { AccountPasswordPolicy } from "./password-policy.ts";
import {
  passwordRecoveryRoutes,
  resetLinkRenderer,
} from "./password-recovery.ts";
import { collectAttachments } from "./vault/attachments.ts";
import { vaultAttachmentRoutes } from "./vault/web-attachments.ts";
import { vaultManagementRoutes } from "./vault/management.ts";
import { vaultItemRoutes } from "./vault/items.ts";
import { vaultSetupRoutes } from "./vault/setup.ts";

const health = HttpRouter.add(
  "GET",
  "/api/health",
  HttpServerResponse.json({ ok: true }),
);

declare const FixedLengthStream: typeof import("@cloudflare/workers-types").FixedLengthStream;

export default {
  async email(
    message: Pick<
      ForwardableEmailMessage,
      "from" | "to" | "headers" | "raw" | "rawSize" | "setReject"
    >,
    env: Pick<WorkerEnv, "INBOX_EMAIL_ADDRESS" | "INBOX_MESSAGES">,
  ) {
    if (message.to.toLowerCase() !== env.INBOX_EMAIL_ADDRESS) {
      message.setReject("Unknown recipient");
      return;
    }

    const raw = message.raw.pipeThrough(new FixedLengthStream(message.rawSize));
    await env.INBOX_MESSAGES.put(inboxMessageKey(), raw, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: {
        envelopeFrom: message.from,
        envelopeTo: message.to,
        subject: inboxSubject(message.headers.get("subject")),
      },
    });
  },
  async scheduled(_event: unknown, env: WorkerEnv) {
    await collectAttachments(env.DB, env.VAULT_FILES);
  },
  async fetch(
    request: Request,
    env: WorkerEnv & {
      ASSETS?: { fetch(request: Request): Promise<Response> };
    },
    context?: { waitUntil(promise: Promise<unknown>): void },
  ) {
    const url = new URL(request.url);
    const path = url.pathname;
    const defer = (work: Promise<unknown>) => {
      if (context) context.waitUntil(work);
      else void work;
    };
    if (path.startsWith("/icons/"))
      return bitwardenIcon(request, url, env, defer);
    if (
      (path === forgotPasswordPage || path === resetPasswordPage) &&
      env.ASSETS
    ) {
      const method = request.method;
      if (method !== "GET" && method !== "HEAD")
        return new Response(null, {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      const page = await env.ASSETS.fetch(
        new Request(new URL("/", url), { method }),
      );
      const headers = new Headers(page.headers);
      headers.set(
        "cache-control",
        EmailDelivery.linkLandingHeaders["Cache-Control"],
      );
      headers.set(
        "referrer-policy",
        EmailDelivery.linkLandingHeaders["Referrer-Policy"],
      );
      headers.set(
        "content-security-policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      return new Response(page.body, { status: page.status, headers });
    }
    const signingIn = path === "/api/auth/signIn" && request.method === "POST";
    const accountMutation =
      path.startsWith(accountPath + "/") && request.method === "POST";
    const oauthRequest =
      (path === mcpOAuth.paths.authorize &&
        url.searchParams.has("response_type")) ||
      ([mcpOAuth.paths.token, mcpOAuth.paths.revoke].some(
        (route) => route === path,
      ) &&
        request.method === "POST");
    if (signingIn || oauthRequest || accountMutation) {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const key = signingIn
        ? ip
        : accountMutation
          ? `account:${ip}`
          : `mcp-oauth:${ip}`;
      if (!(await env.AUTH_LIMIT.limit({ key })).success) {
        return Response.json(
          {
            error: signingIn
              ? "Too many sign-in attempts"
              : accountMutation
                ? "Too many attempts. Try again shortly."
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
    const emailTransport =
      env.ACCOUNT_EMAIL && env.EMAIL_FROM
        ? cloudflareEmail(env.ACCOUNT_EMAIL, env.EMAIL_FROM)
        : disabledEmail;
    // Verification dispatch is inline and request-local. Report acceptance only
    // when the provider received the message for this request.
    let emailAccepted = false;
    const emailDelivery: EmailDelivery.EmailDelivery["Service"] = {
      send: (message) =>
        emailTransport.send(message).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              emailAccepted = true;
            }),
          ),
        ),
    };
    const secret = Redacted.make(env.AUTH_SECRET);
    const dependencies = authDependencies(
      database,
      secret,
      AccountPasswordPolicy,
      emailDelivery,
      path === passwordResetPath && context
        ? Layer.succeed(ProofDispatchScheduler, {
            schedule: (work) =>
              Effect.sync(() => {
                context.waitUntil(Effect.runPromise(work));
              }),
          })
        : undefined,
    );
    if (isBitwardenPath(path)) {
      try {
        return await bitwardenFetch(
          request,
          url,
          env,
          () => {
            const cookie =
              HttpServerRequest.fromWeb(request).cookies[sessionCookieName];
            if (cookie === undefined) return Promise.resolve(null);
            return Effect.runPromise(
              Effect.flatMap(AppAuth, (auth) =>
                auth.verifySession(Redacted.make(cookie)),
              ).pipe(
                Effect.map((session) => ({
                  ownerId: session.subjectId,
                  sessionId: session.sessionId,
                  securityRevision: session.securityRevision,
                })),
                Effect.catchTag("SessionInvalid", () => Effect.succeed(null)),
                Effect.provide(AppAuth.layer.pipe(Layer.provide(dependencies))),
              ),
            );
          },
          defer,
        );
      } catch {
        return Response.json(
          { error: "temporarily_unavailable" },
          { status: 503, headers: privateHeaders },
        );
      }
    }
    const app = HttpRouter.toWebHandler(
      Layer.mergeAll(
        health,
        mcpOAuth.routes,
        mcpLoginRoute,
        mcpRoutes(env.APP_ORIGIN),
        Layer.mergeAll(
          accountRoutes(http, {
            enabled: emailTransport !== disabledEmail,
            accepted: () => emailAccepted,
            limit: (input) => env.ACCOUNT_EMAIL_LIMIT.limit(input),
          }),
          emailChangeRoutes(
            http,
            secret,
            emailTransport !== disabledEmail,
            (input) => env.ACCOUNT_EMAIL_LIMIT.limit(input),
          ),
          passwordRecoveryRoutes(http, emailTransport !== disabledEmail),
          linksRoutes(http),
          inboxRoutes(http, env),
          vaultSetupRoutes(http, env.DB),
          vaultItemRoutes(http, env.DB),
          vaultManagementRoutes(http, env, defer),
          vaultAttachmentRoutes(http, env, defer),
          bitwardenDeviceRoutes(http),
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
        Layer.provide(
          http.layer.pipe(
            Layer.provide(dependencies),
            Layer.provide(resetLinkRenderer(env.APP_ORIGIN)),
          ),
        ),
        HttpRouter.provideRequest(dependencies),
        HttpRouter.provideRequest(database),
        Layer.provide(HttpServer.layerServices),
      ),
      {
        disableLogger: true,
      },
    );

    try {
      if (
        request.method === "GET" &&
        path === mcpOAuth.paths.authorize &&
        url.searchParams.get("response_type") === "code" &&
        !url.searchParams.has("scope")
      ) {
        url.searchParams.set("scope", mcpLinkScopes.join(" "));
        return await app.handler(new Request(url, request));
      }
      return await app.handler(request);
    } finally {
      await app.dispose();
    }
  },
};
