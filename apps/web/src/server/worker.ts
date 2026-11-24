import { deliverCalendarPush } from "./calendar-push.ts";
import { calendarRoutes } from "./calendar.ts";
import { mailImportRoutes } from "./mail-import-api.ts";
import { pushRoutes } from "./push-api.ts";
import { deliverMailPush, type PushEnv } from "./push-delivery.ts";
import { removeSessionPush } from "./push-store.ts";
import {
  defaultMailboxId,
  ensureDefaultMailbox,
  requireMailbox,
  resolveMailRecipient,
  mailDatabase,
  mailboxBucket,
  scopeMailStore,
  mailboxIdentities,
} from "./mailbox.ts";
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
import { inboxEventsPath } from "../inbox-contract.ts";
import {
  forgotPasswordPage,
  passwordResetPath,
  resetPasswordPage,
} from "../password-recovery-contract.ts";
import { cloudflareEmail, disabledEmail } from "./account-email.ts";
import { accountRoutes } from "./account.ts";
import { AppAuth, authHttp, ownerId, sessionCookieName } from "./auth.ts";
import { bitwardenDeviceRoutes } from "./bitwarden/devices.ts";
import { bitwardenIcon } from "./bitwarden/icons.ts";
import { bitwardenFetch, isBitwardenPath } from "./bitwarden/routes.ts";
import type { RasterizeSvg } from "./bitwarden/website-icon-svg.ts";
import { privateHeaders } from "./api-response.ts";
import { cliLoginRoutes } from "./cli-login.ts";
import { cliTokenRoutes } from "./cli-tokens.ts";
import { authDependencies, databaseLayer } from "./database.ts";
import { emailChangeRoutes } from "./email-change.ts";
import { extensionAccessRoutes } from "./extension-access.ts";
import {
  inboxMessageKey,
  inboxRoutes,
  inboxSessionHeaders,
  inboxSubject,
  notifyInbox,
  recoverIncomingMail,
  syncMailIndex,
} from "./inbox.ts";
import { collectMailTrash } from "./mail-trash.ts";
import { indexMail, isMailingList } from "./mail-index.ts";
import { mailPeople } from "./mail-people.ts";
import { conversationMessageIds } from "./mail-reply.ts";
import { linksRoutes } from "./links.ts";
import { mcpRoutes } from "./mcp.ts";
import {
  mcpGrantRoutes,
  mcpScopes,
  mcpLoginRoute,
  mcpOAuth,
  mcpOAuthLayer,
} from "./mcp-oauth.ts";
import { AccountPasswordPolicy } from "./password-policy.ts";
import { collectDeletedContacts, peopleRoutes } from "./people.ts";
import {
  passwordRecoveryRoutes,
  resetLinkRenderer,
} from "./password-recovery.ts";
import { tasksRoutes } from "./tasks.ts";
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
    env: Pick<
      WorkerEnv,
      "DB" | "INBOX_EMAIL_ADDRESS" | "INBOX_MESSAGES" | "INBOX_UPDATES"
    > &
      Partial<Pick<WorkerEnv, "MAILBOX_ALIASES" | "INBOX_EMAIL_FROM">> &
      PushEnv,
    context?: { waitUntil(promise: Promise<unknown>): void },
  ) {
    await ensureDefaultMailbox(
      env.DB,
      env.INBOX_EMAIL_ADDRESS,
      env.INBOX_EMAIL_FROM,
      env.MAILBOX_ALIASES,
    );
    const mailboxId = await resolveMailRecipient(env.DB, message.to);
    if (!mailboxId) {
      message.setReject("Unknown recipient");
      return;
    }

    const db = mailDatabase(env.DB, mailboxId);
    const bucket = mailboxBucket(env.INBOX_MESSAGES, mailboxId);
    const raw = message.raw.pipeThrough(new FixedLengthStream(message.rawSize));
    const id = inboxMessageKey();
    const subject = inboxSubject(message.headers.get("subject"));
    const stored = await bucket.put(id, raw, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: {
        envelopeFrom: message.from,
        envelopeTo: message.to,
        subject,
        initialUnread: "1",
        notifyIncoming: "1",
      },
    });
    await indexMail(
      db,
      {
        id,
        folder: "inbox",
        timestamp: stored.uploaded.getTime(),
        subject,
        from: message.from,
        to: message.to,
        envelopeRecipient: message.to,
        unread: true,
        notifyIncoming: true,
        listMail: isMailingList(message.headers.get("list-id")),
        people: mailPeople(
          (name) => message.headers.get(name),
          message.from,
          message.to,
        ),
        messageIds: conversationMessageIds((name) => message.headers.get(name)),
      },
      { reopensArchive: true },
    ).catch(() => console.warn("Could not index incoming email"));
    const notify = Promise.all([
      notifyInbox({ ...env, DB: db }),
      deliverMailPush(env).catch(() =>
        console.warn("Could not process mail push outbox"),
      ),
    ]);
    if (context) context.waitUntil(notify);
    else await notify;
  },
  async scheduled(event: { scheduledTime?: number }, env: WorkerEnv) {
    await Promise.all([
      deliverMailPush(env),
      deliverCalendarPush(env).catch(() =>
        console.warn("Could not process calendar push outbox"),
      ),
    ]);
    // Retry push and recover recent arrivals every minute; retain the existing
    // 15-minute maintenance cadence for full scans and garbage collection.
    const maintenance =
      event.scheduledTime === undefined ||
      Math.floor(event.scheduledTime / 60_000) % 15 === 0;
    await ensureDefaultMailbox(
      env.DB,
      env.INBOX_EMAIL_ADDRESS,
      env.INBOX_EMAIL_FROM,
      env.MAILBOX_ALIASES,
    );
    if (maintenance)
      await Promise.all([
        collectAttachments(env.DB, env.VAULT_FILES),
        collectDeletedContacts(env),
      ]);
    const { results } = await env.DB.prepare("SELECT id FROM mailboxes").all<{
      id: string;
    }>();
    for (const { id } of results) {
      const store = { ...scopeMailStore(env, id), mailboxAddresses: [] };
      await recoverIncomingMail(store);
      if (maintenance) {
        await collectMailTrash(store);
        await syncMailIndex(store, true);
      }
    }
    await deliverMailPush(env);
  },
  async fetch(
    request: Request,
    env: WorkerEnv & {
      ASSETS?: { fetch(request: Request): Promise<Response> };
    },
    context?: { waitUntil(promise: Promise<unknown>): void },
    rasterizeSvg?: RasterizeSvg,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const defer = (work: Promise<unknown>) => {
      if (context) context.waitUntil(work);
      else void work;
    };
    if (path.startsWith("/icons/"))
      return bitwardenIcon(request, url, env, defer, rasterizeSvg);
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
    const verifyBrowserSession = () => {
      const cookie =
        HttpServerRequest.fromWeb(request).cookies[sessionCookieName];
      if (cookie === undefined) return Promise.resolve(null);
      return Effect.runPromise(
        Effect.flatMap(AppAuth, (auth) =>
          auth.verifySession(Redacted.make(cookie)),
        ).pipe(
          Effect.catchTag("SessionInvalid", () => Effect.succeed(null)),
          Effect.provide(AppAuth.layer.pipe(Layer.provide(dependencies))),
        ),
      );
    };
    if (path === inboxEventsPath) {
      if (request.method !== "GET")
        return new Response(null, {
          status: 405,
          headers: { ...privateHeaders, allow: "GET" },
        });
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return new Response(null, { status: 426, headers: privateHeaders });
      if (request.headers.get("origin") !== new URL(env.APP_ORIGIN).origin)
        return new Response(null, { status: 403, headers: privateHeaders });
      try {
        const session = await verifyBrowserSession();
        if (!session)
          return new Response(null, { status: 401, headers: privateHeaders });
        if (session.subjectId !== ownerId)
          return new Response(null, { status: 403, headers: privateHeaders });
        await ensureDefaultMailbox(
          env.DB,
          env.INBOX_EMAIL_ADDRESS,
          env.INBOX_EMAIL_FROM,
          env.MAILBOX_ALIASES,
        );
        await requireMailbox(env.DB, defaultMailboxId, session.subjectId);
        // Return the native response so its WebSocket survives the upgrade.
        return await env.INBOX_UPDATES.getByName(defaultMailboxId).fetch(
          request.url,
          {
            headers: {
              upgrade: "websocket",
              [inboxSessionHeaders.mailbox]: defaultMailboxId,
              [inboxSessionHeaders.id]: session.sessionId,
              [inboxSessionHeaders.revision]: session.securityRevision,
            },
          },
        );
      } catch {
        return new Response(null, { status: 503, headers: privateHeaders });
      }
    }
    if (isBitwardenPath(path)) {
      try {
        return await bitwardenFetch(
          request,
          url,
          env,
          async () => {
            const session = await verifyBrowserSession();
            return (
              session && {
                ownerId: session.subjectId,
                sessionId: session.sessionId,
                securityRevision: session.securityRevision,
              }
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
    let mailRoutes: ReturnType<typeof inboxRoutes> = Layer.empty;
    if (path.startsWith("/api/inbox")) {
      await ensureDefaultMailbox(
        env.DB,
        env.INBOX_EMAIL_ADDRESS,
        env.INBOX_EMAIL_FROM,
        env.MAILBOX_ALIASES,
      );
      const store = scopeMailStore(env, defaultMailboxId);
      const identities = await mailboxIdentities(store.DB);
      mailRoutes = inboxRoutes(
        http,
        {
          ...store,
          // Permission in the mailbox and support from the sending transport
          // must both be present. Aliases never imply send-as permission.
          INBOX_EMAIL_FROM: identities.some(
            (identity) =>
              identity.address === env.INBOX_EMAIL_FROM &&
              identity.canSend === 1,
          )
            ? env.INBOX_EMAIL_FROM
            : undefined,
          INBOX_EMAIL_ADDRESS:
            identities.find(
              (identity) =>
                identity.address === env.INBOX_EMAIL_ADDRESS &&
                identity.canReceive === 1,
            )?.address ??
            identities.find((identity) => identity.canReceive === 1)?.address,
          mailboxAddresses: identities.map((identity) => identity.address),
        },
        defer,
      );
    }
    const app = HttpRouter.toWebHandler(
      Layer.mergeAll(
        health,
        mcpOAuth.routes,
        mcpLoginRoute,
        mcpRoutes(env.APP_ORIGIN, env.DB),
        Layer.mergeAll(
          accountRoutes(http, {
            enabled: emailTransport !== disabledEmail,
            accepted: () => emailAccepted,
            limit: (input) => env.ACCOUNT_EMAIL_LIMIT.limit(input),
          }),
          pushRoutes(http, env),
          emailChangeRoutes(
            http,
            secret,
            emailTransport !== disabledEmail,
            (input) => env.ACCOUNT_EMAIL_LIMIT.limit(input),
          ),
          passwordRecoveryRoutes(http, emailTransport !== disabledEmail),
          linksRoutes(http),
          mailRoutes,
          mailImportRoutes(env, defer),
          peopleRoutes(http, env, defer),
          calendarRoutes(http, env),
          tasksRoutes(http, env.DB),
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
        url.searchParams.set("scope", mcpScopes.join(" "));
        return await app.handler(new Request(url, request));
      }
      const signingOut =
        path === "/api/auth/signOut" && request.method === "POST";
      const signingOutSession = signingOut
        ? await verifyBrowserSession()
        : null;
      const response = await app.handler(request);
      if (response.ok && signingOutSession)
        await removeSessionPush(env.DB, signingOutSession.sessionId);
      return response;
    } finally {
      await app.dispose();
    }
  },
};
