import { expect, it, vi } from "@effect/vitest";
import {
  cliLinkScopes,
  cliLoginPath,
  cliTokensPath,
} from "@oneapp/core/cli-auth";
import { extensionAccessPath, digestSecret } from "@oneapp/core/extension-auth";
import {
  linkPath,
  linksPath,
  linksReadScope,
  linksWriteScope,
} from "@oneapp/core/links";
import { EmailDelivery } from "@yielded/auth";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { ConfigProvider, Effect, Redacted, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import type { WorkerEnv } from "../../../../alchemy.run.ts";
import {
  emailChangePath,
  emailVerificationPath,
  passwordChangePath,
} from "../account-contract.ts";
import { bitwardenDevicesPath } from "../bitwarden-device-contract.ts";
import {
  conversationApi,
  conversationsApiPath,
  inboxApiPath,
  inboxEventsPath,
  inboxMessageApi,
  inboxOriginalApi,
  inboxSendPath,
  mailMessageApi,
  sentApiPath,
  sentCopyHeader,
} from "../inbox-contract.ts";
import {
  codexClientId,
  McpGrantList,
  mcpGrantsPath,
} from "../mcp-access-contract.ts";
import {
  passwordResetPath,
  resetPasswordPage,
} from "../password-recovery-contract.ts";
import {
  vaultAttachmentPath,
  vaultAttachmentsPath,
  vaultAttachmentLimit,
  vaultAttachmentQuota,
} from "../vault-attachment-contract.ts";
import { vaultImportPath } from "../vault-transfer-contract.ts";
import { vaultSetupPath } from "../vault-setup-contract.ts";
import {
  vaultBulkPath,
  vaultFolderPath,
  vaultFoldersPath,
  VaultItem,
  vaultItemPath,
  vaultItemsPath,
  type VaultLifecycleAction,
  vaultLifecyclePath,
  VaultSnapshot,
} from "../vault-items-contract.ts";
import { extraItemTypes, itemTypes } from "../vault-item-content.ts";
import { createVaultSetup } from "../vault-crypto.ts";
import { deviceLifetimeMillis, randomSecret } from "./bitwarden/tokens.ts";
import { digest } from "./digest.ts";
import { ensureOwner } from "./provision-owner.ts";
import { mcpOAuth } from "./mcp-oauth.ts";
import worker from "./worker.ts";

const email = "owner@example.net";
const password = "p".repeat(43);

const setup = async (
  sqlite: Database,
  inbox?: Partial<
    Pick<
      WorkerEnv,
      | "INBOX_MESSAGES"
      | "INBOX_EMAIL_ADDRESS"
      | "INBOX_UPDATES"
      | "INBOX_EMAIL_FROM"
      | "SENT_MESSAGES"
    >
  > & { INBOX_SEND?: SendEmail; INBOX_SEND_LIMIT?: RateLimit },
) => {
  const migrationRoot = new URL("../../drizzle/", import.meta.url).pathname;
  for (const entry of Array.from(
    new Bun.Glob("*/migration.sql").scanSync(migrationRoot),
  ).sort()) {
    sqlite.exec(await Bun.file(migrationRoot + entry).text());
  }

  sqlite.exec("PRAGMA foreign_keys = ON");
  const bind = (sql: string, params: SQLQueryBindings[]) => {
    const execute = () => ({ results: sqlite.query(sql).all(...params) });
    return {
      execute,
      all: async () => execute(),
      run: async () => execute(),
      first: async () => execute().results[0] ?? null,
      raw: async () => sqlite.query(sql).values(...params),
    };
  };
  let emailAvailable = true;
  const messages: { from: string; to: string; text: string }[] = [];
  const deliveries: Promise<unknown>[] = [];
  let dropStoredFileResponse = false;
  const objects = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; customMetadata: { sha256: string } }
  >();
  const env = {
    ...inbox,
    VAULT_FILES: {
      put: async (
        id: string,
        bytes: Uint8Array<ArrayBuffer>,
        options: { customMetadata: { sha256: string } },
      ) => {
        if (objects.has(id)) return null;
        const object = {
          bytes: bytes.slice(),
          customMetadata: options.customMetadata,
        };
        objects.set(id, object);
        if (dropStoredFileResponse) {
          dropStoredFileResponse = false;
          throw new Error("Fixture lost response after storing object");
        }
        return object;
      },
      head: async (id: string) => objects.get(id) ?? null,
      get: async (id: string) => {
        const object = objects.get(id);
        return object
          ? { size: object.bytes.length, body: new Response(object.bytes).body }
          : null;
      },
      delete: async (ids: string | string[]) => {
        for (const id of Array.isArray(ids) ? ids : [ids]) objects.delete(id);
      },
    },
    DB: {
      prepare: (sql: string) => ({
        bind: (...params: SQLQueryBindings[]) => bind(sql, params),
      }),
      batch: async (statements: ReturnType<typeof bind>[]) =>
        sqlite.transaction(() =>
          statements.map((statement) => statement.execute()),
        )(),
    },
    APP_ORIGIN: "https://oneapp.example",
    AUTH_SECRET: "x".repeat(43),
    MCP_OAUTH_SECRET: "y".repeat(43),
    AUTH_LIMIT: { limit: async () => ({ success: true }) },
    ACCOUNT_EMAIL_LIMIT: { limit: async () => ({ success: true }) },
    CLI_LOGIN_LIMIT: { limit: async () => ({ success: true }) },
    EMAIL_FROM: "accounts@oneapp.example",
    ASSETS: { fetch: async () => new Response("<html></html>") },
    ACCOUNT_EMAIL: {
      send: async (message: { from: string; to: string; text: string }) => {
        if (!emailAvailable) throw new Error("Email unavailable");
        messages.push(message);
      },
    },
  } as unknown as WorkerEnv;
  const provision = (config: Record<string, string>) =>
    Effect.runPromise(
      ensureOwner(env.DB).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(config),
        ),
      ),
    );
  await provision({
    OWNER_EMAIL: email,
    OWNER_PASSWORD: password,
    AUTH_SECRET: env.AUTH_SECRET,
  });

  const request = (path: string, init: RequestInit) =>
    worker.fetch(new Request(new URL(path, env.APP_ORIGIN), init), env, {
      waitUntil: (work) => deliveries.push(work),
    });
  const call = (
    path: string,
    body?: object,
    cookie?: string,
    origin = env.APP_ORIGIN,
  ) =>
    request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "x-effect-auth-csrf": "1",
        origin,
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const signIn = (candidate: string, address = email) =>
    call("/api/auth/signIn", {
      payload: { email: address, password: candidate },
    });
  const cookies = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((header) => header.split(";")[0])
      .join("; ");

  return {
    call,
    request,
    objects,
    finishWork: () => Promise.all(deliveries),
    loseStoredFileResponse: () => {
      dropStoredFileResponse = true;
    },
    signIn,
    cookies,
    messages,
    from: env.EMAIL_FROM,
    provision,
    awaitDeliveries: () => Promise.all(deliveries.splice(0)),
    setEmailAvailable: (available: boolean) => {
      emailAvailable = available;
    },
  };
};

it("lets only the owner send plain-text mail from the configured Inbox address", async () => {
  using sqlite = new Database(":memory:");
  const from = "mail@app.example.net";
  const send = vi.fn(async (_message: EmailMessageBuilder) => ({
    messageId: "fixture-mail",
  }));
  const stored = new Map<
    string,
    { key: string; value: string; customMetadata: Record<string, string> }
  >();
  const save = async (
    key: string,
    value: string,
    options: { customMetadata: Record<string, string> },
  ) => {
    const object = { key, value, customMetadata: options.customMetadata };
    stored.set(key, object);
    return object;
  };
  const put = vi.fn(save);
  const limit = vi.fn(async (_input: { key: string }) => ({ success: true }));
  const { call, request, signIn, cookies } = await setup(sqlite, {
    INBOX_EMAIL_ADDRESS: from,
    INBOX_EMAIL_FROM: from,
    INBOX_SEND: { send } as SendEmail,
    INBOX_SEND_LIMIT: { limit },
    INBOX_MESSAGES: {
      list: async () => ({ objects: [], truncated: false }),
    } as WorkerEnv["INBOX_MESSAGES"],
    SENT_MESSAGES: {
      put,
      list: async () => ({ objects: [...stored.values()], truncated: false }),
      get: async (id: string) => {
        const object = stored.get(id);
        return object ? { json: async () => JSON.parse(object.value) } : null;
      },
      delete: async (id: string) => void stored.delete(id),
    } as unknown as WorkerEnv["SENT_MESSAGES"],
  });
  const session = cookies(await signIn(password));
  const draft = {
    to: " Alice+Details@Example.NET ",
    subject: " Meeting notes ",
    text: "Hi Alice,\n\nThanks!\n",
  };
  const approved = (input: object = draft) =>
    call(inboxSendPath, input, session);
  expect(
    await (await call(inboxApiPath, undefined, session)).json(),
  ).toMatchObject({ address: from, sender: from });
  expect((await call(inboxSendPath, draft)).status).toBe(401);
  expect((await call(sentApiPath)).status).toBe(401);
  expect(
    (await call(inboxSendPath, draft, session, "https://other.example")).status,
  ).toBe(403);
  expect(
    (
      await request(inboxSendPath, {
        method: "POST",
        headers: {
          cookie: session,
          origin: "https://oneapp.example",
          "content-type": "application/json",
        },
        body: JSON.stringify(draft),
      })
    ).status,
  ).toBe(403);
  expect((await approved({ ...draft, from: "other@example.net" })).status).toBe(
    400,
  );
  expect(
    (await approved({ ...draft, to: "bob@example.net,alice@example.net" }))
      .status,
  ).toBe(400);
  expect(
    (await approved({ ...draft, subject: "Hello\r\nBcc: other@example.net" }))
      .status,
  ).toBe(400);
  expect((await approved({ ...draft, text: "  \n" })).status).toBe(400);
  expect(limit).not.toHaveBeenCalled();
  limit.mockResolvedValueOnce({ success: false });
  expect((await approved()).status).toBe(429);
  expect(send).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();

  put.mockImplementationOnce(async (...args) => {
    await save(...args);
    throw new Error("Fixture lost the response to a successful write");
  });
  const accepted = await approved();
  expect(accepted.status).toBe(204);
  expect(accepted.headers.get("cache-control")).toBe("no-store");
  expect(accepted.headers.get(sentCopyHeader)).toBeNull();
  expect(send).toHaveBeenCalledExactlyOnceWith({
    from,
    to: "Alice+Details@Example.NET",
    subject: "Meeting notes",
    text: draft.text,
  });
  expect(put).toHaveBeenCalledTimes(2);
  expect(put.mock.calls[0]).toEqual(put.mock.calls[1]);
  expect(stored.size).toBe(1);
  const [copy] = stored.values();
  if (!copy) throw new Error("Expected an archived copy");
  expect(JSON.parse(copy.value)).toMatchObject({
    id: copy.key,
    text: draft.text,
    providerMessageId: "fixture-mail",
  });
  const sentList = await call(sentApiPath, undefined, session);
  expect(sentList.status).toBe(200);
  expect(sentList.headers.get("cache-control")).toBe("no-store");
  const entrySummary = {
    id: copy.key,
    from,
    to: "Alice+Details@Example.NET",
    subject: "Meeting notes",
    sentAt: expect.any(Number),
  };
  expect(await sentList.json()).toEqual({
    messages: [entrySummary],
    cursor: null,
    address: from,
    sender: from,
  });
  const detail = mailMessageApi("sent", copy.key);
  expect((await call(detail)).status).toBe(401);
  expect(
    (await call(inboxMessageApi(copy.key), undefined, session)).status,
  ).toBe(404);
  expect(await (await call(detail, undefined, session)).json()).toEqual({
    ...entrySummary,
    text: draft.text,
    preview: "complete",
  });
  send.mockRejectedValueOnce(
    Object.assign(new Error("Provider details"), {
      code: "E_RECIPIENT_SUPPRESSED",
    }),
  );
  const suppressed = await approved();
  expect(suppressed.status).toBe(422);
  expect(await suppressed.json()).toEqual({
    error: "Cloudflare has suppressed this recipient address.",
  });
  send.mockRejectedValueOnce(new Error("Provider details"));
  const uncertain = await approved();
  expect(uncertain.status).toBe(502);
  expect(await uncertain.json()).toEqual({
    error: "Could not confirm whether the email was sent.",
  });
  expect(send).toHaveBeenCalledTimes(3);
  expect(put).toHaveBeenCalledTimes(2);

  const failure = new Error("Storage unavailable");
  put
    .mockRejectedValueOnce(failure)
    .mockRejectedValueOnce(failure)
    .mockRejectedValueOnce(failure);
  const unsaved = await approved();
  expect(unsaved.status).toBe(204);
  expect(unsaved.headers.get(sentCopyHeader)).toBe("failed");
  expect(send).toHaveBeenCalledTimes(4);
  expect(put).toHaveBeenCalledTimes(5);
  expect(stored.size).toBe(1);

  const remove = (cookie?: string, csrf = false) =>
    request(detail, {
      method: "DELETE",
      headers: {
        origin: "https://oneapp.example",
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { "x-effect-auth-csrf": "1" } : {}),
      },
    });
  expect((await remove()).status).toBe(401);
  expect((await remove(session)).status).toBe(403);
  expect((await remove(session, true)).status).toBe(204);
  expect((await call(detail, undefined, session)).status).toBe(404);
});

it("threads replies from the stored message and archives the sent copy", async () => {
  using sqlite = new Database(":memory:");
  const from = "mail@app.example.net";
  const originalId = "0-8199999999990-00000000-0000-4000-8000-000000000000.eml";
  const legacyId = "0-8199999999991-00000000-0000-4000-8000-000000000000.eml";
  const messageId = "<parent@example.net>";
  const root = "<root@example.net>";
  const ancestor = "<ancestor@example.net>";
  const encode = (lines: string[]) =>
    new TextEncoder().encode(lines.join("\r\n"));
  const originals = new Map([
    [
      originalId,
      encode([
        "From: Sender <sender@example.net>",
        "Reply-To: Desk <desk@example.net>",
        "Subject: Checking in",
        `Message-ID: ${messageId}`,
        `References: ${root}`,
        ` ${ancestor} ${root}`,
        "",
        "Hello.",
        "",
      ]),
    ],
    [
      legacyId,
      encode([
        "From: Sender <sender@example.net>",
        "Subject: Checking in",
        `In-Reply-To: ${root}`,
        "",
        "Remember me?",
        "",
      ]),
    ],
  ]);
  const get = vi.fn(
    async (key: string, options?: { range: { length: number } }) => {
      const bytes = originals.get(key);
      if (!bytes) return null;
      const body = new Response(bytes.slice(0, options?.range.length));
      return {
        key,
        size: bytes.length,
        uploaded: new Date("2026-11-19T00:15:00.000Z"),
        customMetadata: {
          envelopeFrom: "bounce@example.net",
          envelopeTo: from,
        },
        text: () => body.text(),
        arrayBuffer: () => body.arrayBuffer(),
      };
    },
  );
  const send = vi.fn(async (_message: EmailMessageBuilder) => ({
    messageId: "reply-fixture",
  }));
  const put = vi.fn(async (_id: string, _json: string) => ({}));
  const { call, signIn, cookies } = await setup(sqlite, {
    INBOX_EMAIL_ADDRESS: from,
    INBOX_EMAIL_FROM: from,
    INBOX_SEND: { send } as SendEmail,
    INBOX_SEND_LIMIT: { limit: async () => ({ success: true }) },
    INBOX_MESSAGES: { get } as unknown as WorkerEnv["INBOX_MESSAGES"],
    SENT_MESSAGES: { put } as unknown as WorkerEnv["SENT_MESSAGES"],
  });
  const session = cookies(await signIn(password));
  const opened = await call(inboxMessageApi(originalId), undefined, session);
  expect(await opened.json()).toMatchObject({
    reply: { to: "desk@example.net", threaded: true },
  });
  const legacy = await call(inboxMessageApi(legacyId), undefined, session);
  expect(await legacy.json()).toMatchObject({
    reply: { to: "sender@example.net", threaded: false },
  });
  const draft = {
    to: "desk@example.net",
    subject: "Re: Checking in",
    text: "Thanks!\n\n> Hello.",
  };
  const reply = { ...draft, replyToId: originalId };
  expect((await call(inboxSendPath, reply)).status).toBe(401);
  expect(
    (
      await call(
        inboxSendPath,
        { ...reply, headers: { "In-Reply-To": "<forged@example.net>" } },
        session,
      )
    ).status,
  ).toBe(400);
  const missingId = originalId.replace("8199999999990", "8199999999999");
  expect(
    (await call(inboxSendPath, { ...reply, replyToId: missingId }, session))
      .status,
  ).toBe(404);
  expect(send).not.toHaveBeenCalled();

  const accepted = await call(inboxSendPath, reply, session);
  expect(accepted.status).toBe(204);
  const headers = {
    "In-Reply-To": messageId,
    References: `${root} ${ancestor} ${messageId}`,
  };
  expect(send).toHaveBeenCalledExactlyOnceWith({ ...draft, from, headers });
  expect(get).toHaveBeenLastCalledWith(originalId, {
    range: { offset: 0, length: 256 * 1024 },
  });
  const [key, record] = put.mock.lastCall ?? [];
  if (!key || !record) throw new Error("Expected a Sent copy");
  expect(JSON.parse(record)).toMatchObject({
    ...draft,
    id: key,
    from,
    providerMessageId: "reply-fixture",
    reply: { originalId, headers },
  });

  const legacyDraft = { ...draft, to: "sender@example.net" };
  expect(
    (
      await call(
        inboxSendPath,
        { ...legacyDraft, replyToId: legacyId },
        session,
      )
    ).status,
  ).toBe(204);
  expect(send).toHaveBeenLastCalledWith({
    ...legacyDraft,
    from,
    headers: { References: root },
  });
});

it("groups existing mail across Inbox and Sent as its threads are discovered", async () => {
  using sqlite = new Database(":memory:");
  const address = "mail@app.example.net";
  const subject = "Status update";
  const makeInbox = (number: number, timestamp: number, headers: string[]) => {
    const key = `0-819999999999${number}-00000000-0000-4000-8000-000000000000.eml`;
    const raw = [
      "From: sender@example.net",
      `Subject: ${subject}`,
      ...headers,
      "",
      "Hello.",
    ].join("\r\n");
    return {
      key,
      size: raw.length,
      uploaded: new Date(timestamp),
      raw,
      customMetadata: {
        envelopeFrom: "sender@example.net",
        envelopeTo: address,
        subject,
      },
    };
  };
  const root = makeInbox(0, 1000, ["Message-ID: <a@example.net>"]);
  const branch = makeInbox(1, 2000, ["Message-ID: <b@example.net>"]);
  const latest = makeInbox(2, 4000, ["In-Reply-To: <b@example.net>"]);
  const bridge = makeInbox(3, 3000, [
    "References: <a@example.net> <b@example.net>",
  ]);
  const separate = makeInbox(4, 5000, ["Message-ID: <separate@example.net>"]);
  const objects = new Map(
    [root, branch, latest, bridge, separate].map((item) => [item.key, item]),
  );
  const sentId = "0-8199999999990-00000000-0000-4000-8000-000000000000";
  const sent = {
    id: sentId,
    from: address,
    to: "sender@example.net",
    subject: `Re: ${subject}`,
    sentAt: 2500,
    text: "A saved reply.",
    providerMessageId: "<sent@example.net>",
    reply: { originalId: root.key },
  };
  const { call, request, signIn, cookies } = await setup(sqlite, {
    INBOX_EMAIL_ADDRESS: address,
    INBOX_MESSAGES: {
      list: async ({ cursor }: { cursor?: string }) =>
        cursor
          ? { objects: [bridge, separate], truncated: false }
          : {
              objects: [root, branch, latest],
              truncated: true,
              cursor: "older",
            },
      get: async (id: string) => {
        const item = objects.get(id);
        return item ? { ...item, text: async () => item.raw } : null;
      },
      delete: async (id: string) => void objects.delete(id),
    } as unknown as WorkerEnv["INBOX_MESSAGES"],
    SENT_MESSAGES: {
      list: async () => ({ objects: [{ key: sentId }], truncated: false }),
      get: async () => ({ json: async () => sent }),
    } as unknown as WorkerEnv["SENT_MESSAGES"],
  });
  expect((await call(conversationsApiPath)).status).toBe(401);
  expect((await call(conversationApi(root.key))).status).toBe(401);
  const session = cookies(await signIn(password));
  const get = async (path: string) => {
    const result = await call(path, undefined, session);
    expect(result.status).toBe(200);
    return result.json();
  };
  expect(await get(conversationsApiPath)).toMatchObject({
    indexing: true,
    messages: [
      { id: latest.key, messageCount: 2 },
      { id: root.key, messageCount: 2 },
    ],
  });
  expect(await get(conversationsApiPath)).toMatchObject({
    messages: [
      { id: separate.key, messageCount: 1 },
      { id: latest.key, messageCount: 5 },
    ],
  });
  const expected = [root.key, branch.key, sentId, bridge.key, latest.key];
  for (const anchor of [root.key, branch.key, sentId, latest.key]) {
    const thread = await get(conversationApi(anchor));
    expect(thread.messages.map(({ id }: { id: string }) => id)).toEqual(
      expected,
    );
  }
  const qs = new URLSearchParams({ cursor: `5000/${separate.key}` });
  expect(await get(`${conversationsApiPath}?${qs}`)).toMatchObject({
    messages: [{ id: latest.key, messageCount: 5 }],
  });
  const removed = await request(inboxMessageApi(latest.key), {
    method: "DELETE",
    headers: {
      cookie: session,
      origin: "https://oneapp.example",
      "x-effect-auth-csrf": "1",
    },
  });
  expect(removed.status).toBe(204);
  expect(await get(conversationsApiPath)).toMatchObject({
    messages: [
      { id: separate.key, messageCount: 1 },
      { id: bridge.key, messageCount: 4 },
    ],
  });
  const updated = await get(conversationApi(root.key));
  expect(updated.messages.map(({ id }: { id: string }) => id)).toEqual(
    expected.slice(0, -1),
  );
});

it("only upgrades Inbox sockets for a same-origin owner session", async () => {
  using sqlite = new Database(":memory:");
  const accept = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(null, { status: 204 }),
  );
  const { request, signIn, cookies } = await setup(sqlite, {
    INBOX_UPDATES: {
      getByName: () => ({ fetch: accept }),
    } as WorkerEnv["INBOX_UPDATES"],
  });
  const cookie = cookies(await signIn(password));
  const headers = {
    upgrade: "websocket",
    origin: "https://oneapp.example",
    "x-oneapp-inbox-session-id": "forged",
    "x-oneapp-inbox-security-revision": "forged",
  };
  expect((await request(inboxEventsPath, { headers })).status).toBe(401);
  expect(
    (
      await request(inboxEventsPath, {
        headers: { ...headers, cookie, origin: "https://other.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(inboxEventsPath, {
        headers: { origin: headers.origin, cookie },
      })
    ).status,
  ).toBe(426);
  expect(accept).not.toHaveBeenCalled();

  const allowed = await request(inboxEventsPath, {
    headers: { ...headers, cookie },
  });
  expect(allowed.status).toBe(204);
  expect(accept).toHaveBeenCalledOnce();
  const forwarded = new Headers(accept.mock.calls[0]?.[1].headers);
  const session = sqlite
    .query<{ id: string; revision: string }, []>(
      "SELECT session_id AS id, security_revision AS revision FROM oneapp_auth_sessions",
    )
    .get();
  expect(session).not.toBeNull();
  expect(forwarded.get("upgrade")).toBe("websocket");
  expect(forwarded.has("cookie")).toBe(false);
  expect(forwarded.get("x-oneapp-inbox-session-id")).toBe(session?.id);
  expect(forwarded.get("x-oneapp-inbox-security-revision")).toBe(
    session?.revision,
  );
});

it("allows the owner to list, read, download, and permanently delete stored mail", async () => {
  using sqlite = new Database(":memory:");
  const address = "mail@app.example.net";
  const sender = "bounces@example.net";
  const legacy =
    "2026-11-19T00:15:00.000Z-85c03fc3-8e33-42dd-af09-76d1890aa307.eml";
  const newest = "0-8200000000000-85c03fc3-8e33-42dd-af09-76d1890aa307.eml";
  const metadata = { envelopeFrom: sender, envelopeTo: address };
  const raw = [
    "From: Example Team <team@example.net>",
    "Subject: =?UTF-8?Q?Coffee_=E2=98=95?=",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p>Hello <strong>there</strong>.</p><script>secret()</script><img src="https://tracking.example.net/pixel">',
    "",
  ].join("\r\n");
  const bytes = new TextEncoder().encode(raw);
  const stored = new Set([legacy, newest]);
  const object = (key: string) => ({
    key,
    size: bytes.length,
    uploaded: new Date("2026-11-19T00:15:00.000Z"),
    customMetadata:
      key === newest ? { ...metadata, subject: "Coffee ☕" } : metadata,
  });
  const list = vi.fn(async ({ cursor }: { cursor?: string }) =>
    cursor
      ? {
          objects: stored.has(legacy) ? [object(legacy)] : [],
          truncated: false,
        }
      : { objects: [object(newest)], truncated: true, cursor: "next-page" },
  );
  const get = vi.fn(
    async (key: string, options?: { range: { length: number } }) => {
      if (!stored.has(key)) return null;
      const response = new Response(
        options ? bytes.slice(0, options.range.length) : bytes,
      );
      return {
        ...object(key),
        body: response.body,
        text: () => response.text(),
        arrayBuffer: () => response.arrayBuffer(),
      };
    },
  );
  const remove = vi.fn(async (key: string) => {
    stored.delete(key);
  });
  const { call, request, signIn, cookies } = await setup(sqlite, {
    INBOX_EMAIL_ADDRESS: address,
    INBOX_MESSAGES: {
      list,
      get,
      delete: remove,
    } as WorkerEnv["INBOX_MESSAGES"],
  });
  for (const path of [
    inboxApiPath,
    inboxMessageApi(legacy),
    inboxOriginalApi(legacy),
  ]) {
    expect((await call(path)).status).toBe(401);
  }
  expect(list).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();

  const session = cookies(await signIn(password));
  const first = await call(inboxApiPath, undefined, session);
  expect(first.headers.get("cache-control")).toBe("no-store");
  const firstPage = await first.json();
  expect(firstPage).not.toHaveProperty("sender");
  expect(firstPage).toMatchObject({
    address,
    cursor: "next-page",
    messages: [{ id: newest, from: sender, subject: "Coffee ☕" }],
  });
  expect(get).not.toHaveBeenCalled();
  const next = await call(
    inboxApiPath + "?cursor=next-page",
    undefined,
    session,
  );
  expect(await next.json()).toMatchObject({
    cursor: null,
    messages: [{ id: legacy, subject: "Coffee ☕" }],
  });
  expect(get).toHaveBeenLastCalledWith(legacy, {
    range: { offset: 0, length: bytes.length },
  });

  const opened = await call(inboxMessageApi(legacy), undefined, session);
  expect(opened.headers.get("cache-control")).toBe("no-store");
  expect(await opened.json()).toMatchObject({
    subject: "Coffee ☕",
    from: "Example Team <team@example.net>",
    to: address,
    text: "Hello there.",
    preview: "complete",
  });
  const original = await call(inboxOriginalApi(legacy), undefined, session);
  expect(original.headers.get("content-disposition")).toBe(
    `attachment; filename="${legacy}"`,
  );
  expect(original.headers.get("cache-control")).toBe("no-store");
  expect(await original.text()).toBe(raw);
  expect(
    (await call(inboxMessageApi("unknown"), undefined, session)).status,
  ).toBe(404);

  const deleteMail = (headers: HeadersInit, key = legacy) =>
    request(inboxMessageApi(key), { method: "DELETE", headers });
  const authorized = {
    cookie: session,
    origin: "https://oneapp.example",
    "x-effect-auth-csrf": "1",
  };
  expect((await deleteMail({})).status).toBe(401);
  expect(
    (await deleteMail({ cookie: session, origin: authorized.origin })).status,
  ).toBe(403);
  expect(
    (await deleteMail({ ...authorized, origin: "https://other.example" }))
      .status,
  ).toBe(403);
  expect((await deleteMail(authorized, "unknown")).status).toBe(404);
  expect(remove).not.toHaveBeenCalled();

  remove.mockRejectedValueOnce(new Error("R2 unavailable"));
  expect((await deleteMail(authorized)).status).toBe(503);
  expect(stored.has(legacy)).toBe(true);
  const deleted = await deleteMail(authorized);
  expect(deleted.status).toBe(204);
  expect(deleted.headers.get("cache-control")).toBe("no-store");
  expect(remove).toHaveBeenLastCalledWith(legacy);
  expect((await deleteMail(authorized)).status).toBe(204);
  expect((await call(inboxMessageApi(legacy), undefined, session)).status).toBe(
    404,
  );
  expect(
    (await call(inboxOriginalApi(legacy), undefined, session)).status,
  ).toBe(404);
  const afterDelete = await call(
    inboxApiPath + "?cursor=next-page",
    undefined,
    session,
  );
  expect(await afterDelete.json()).toMatchObject({
    messages: [],
    cursor: null,
  });
  expect(stored.has(newest)).toBe(true);
});

it("issues scoped CLI tokens and applies read and write scopes to the Links API", async () => {
  using sqlite = new Database(":memory:");
  const { call, request, signIn, cookies } = await setup(sqlite);
  const session = cookies(await signIn(password));
  const credential = (
    secret: string,
    path: string,
    method = "GET",
    body?: object,
  ) =>
    request(path, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  const secret = `one_${"a".repeat(43)}`;
  const start = await credential(secret, cliLoginPath, "POST", {
    label: "Laptop",
  });
  expect(start.status).toBe(201);
  const { id } = (await start.json()) as { id: string };
  const approval = `${cliLoginPath}/${id}`;
  expect((await call(approval, { approve: true }, session)).status).toBe(400);
  expect(
    (await call(approval, { approve: true, scopes: cliLinkScopes }, session))
      .status,
  ).toBe(204);
  expect((await credential(secret, `${approval}/poll`, "POST")).status).toBe(
    204,
  );

  expect(
    (
      await call(
        cliTokensPath,
        { label: "Mac mini", scopes: cliLinkScopes },
        session,
      )
    ).status,
  ).toBe(404);
  const tokens = await call(cliTokensPath, undefined, session);
  expect(tokens.status).toBe(200);
  expect(await tokens.json()).toMatchObject([{ id, label: "Laptop" }]);
  const save = await credential(secret, linksPath, "POST", {
    url: "https://example.com/",
  });
  expect(save.status).toBe(201);
  const link = (await save.json()) as { id: string };
  expect(await (await credential(secret, linksPath)).json()).toMatchObject([
    link,
  ]);

  sqlite.run("UPDATE cli_tokens SET scopes = ? WHERE id = ?", [
    JSON.stringify([linksReadScope]),
    id,
  ]);
  expect((await credential(secret, linksPath)).status).toBe(200);
  expect(
    (
      await credential(secret, linksPath, "POST", {
        url: "https://example.org/",
      })
    ).status,
  ).toBe(403);
  expect((await credential(secret, linkPath(link.id), "DELETE")).status).toBe(
    403,
  );

  sqlite.run("UPDATE cli_tokens SET scopes = ? WHERE id = ?", [
    JSON.stringify([linksWriteScope]),
    id,
  ]);
  expect((await credential(secret, linksPath)).status).toBe(403);
  expect((await credential(secret, linkPath(link.id), "DELETE")).status).toBe(
    204,
  );

  const revoked = await request(`${cliTokensPath}/${id}`, {
    method: "DELETE",
    headers: {
      cookie: session,
      origin: "https://oneapp.example",
      "x-effect-auth-csrf": "1",
    },
  });
  expect(revoked.status).toBe(204);
  expect((await credential(secret, linksPath)).status).toBe(401);
  expect((await credential(secret, `${approval}/poll`, "POST")).status).toBe(
    410,
  );

  const extensionSecret = `one_ext_${"b".repeat(43)}`;
  expect(
    (
      await call(
        extensionAccessPath,
        {
          id: crypto.randomUUID(),
          digest: await digestSecret(extensionSecret),
        },
        session,
      )
    ).status,
  ).toBe(204);
  const extensionSave = await credential(extensionSecret, linksPath, "POST", {
    url: "https://example.org/",
  });
  expect(extensionSave.status).toBe(201);
  const extensionLink = (await extensionSave.json()) as { id: string };
  expect((await credential(extensionSecret, linksPath)).status).toBe(401);
  expect(
    (await credential(extensionSecret, linkPath(extensionLink.id), "DELETE"))
      .status,
  ).toBe(401);
});

it("issues MCP link scopes and exposes only the tools a grant authorises", async () => {
  using sqlite = new Database(":memory:");
  const { call, request, signIn, cookies } = await setup(sqlite);
  const session = cookies(await signIn(password));
  const origin = "https://oneapp.example";
  const resource = `${origin}/mcp`;
  const redirectUri = "http://127.0.0.1:52127/callback";
  const form = (
    path: string,
    fields: Record<string, string>,
    cookie?: string,
  ) =>
    request(path, {
      method: "POST",
      headers: { origin, ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(fields),
    });

  const connect = async (scopes?: string[]) => {
    const verifier = Base64Url.encode(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const authorization = new URLSearchParams({
      response_type: "code",
      client_id: codexClientId,
      redirect_uri: redirectUri,
      resource,
      code_challenge_method: "S256",
      code_challenge: Base64Url.encode(new Uint8Array(digest)),
      ...(scopes === undefined ? {} : { scope: scopes.join(" ") }),
    });
    const start = await request(
      `${mcpOAuth.paths.authorize}?${authorization}`,
      { headers: { cookie: session } },
    );
    expect(start.status).toBe(303);
    const consentCookie = [session, cookies(start)].join("; ");
    const consent = await request(mcpOAuth.paths.authorize, {
      headers: { cookie: consentCookie },
    });
    expect(consent.status).toBe(200);
    const csrf = (await consent.text()).match(
      /name="csrf" value="([^"]+)"/,
    )?.[1];
    expect(csrf).toBeDefined();
    const approved = await form(
      mcpOAuth.paths.authorize,
      { decision: "approve", csrf: csrf! },
      consentCookie,
    );
    expect(approved.status, await approved.clone().text()).toBe(303);
    const code = new URL(
      approved.headers.get("location") ?? "",
    ).searchParams.get("code");
    expect(code).toBeTruthy();
    const issued = await form(mcpOAuth.paths.token, {
      grant_type: "authorization_code",
      client_id: codexClientId,
      redirect_uri: redirectUri,
      resource,
      code: code!,
      code_verifier: verifier,
    });
    expect(issued.status, await issued.clone().text()).toBe(200);
    const grant = (await issued.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(grant.scope).toBe(
      (scopes ?? [linksReadScope, linksWriteScope]).join(" "),
    );
    return grant;
  };

  const mcp = async (token: string, method: string, params = {}) => {
    const response = await request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const data = response.headers
      .get("content-type")
      ?.startsWith("text/event-stream")
      ? body.match(/^data: (.+)$/m)?.[1]
      : body;
    return JSON.parse(data ?? "") as {
      error?: { message: string };
      result?: { tools?: { name: string }[]; structuredContent?: unknown };
    };
  };
  const names = async (token: string) =>
    (await mcp(token, "tools/list")).result?.tools
      ?.map(({ name }) => name)
      .sort();
  const useTool = (token: string, name: string, args = {}) =>
    mcp(token, "tools/call", { name, arguments: args });

  const challenge = await request("/mcp", { method: "POST" });
  expect(challenge.status).toBe(401);
  expect(challenge.headers.get("www-authenticate")).toContain(
    `scope="${linksReadScope} ${linksWriteScope}"`,
  );
  const metadata = await request(
    "/.well-known/oauth-protected-resource/mcp",
    {},
  );
  expect(await metadata.json()).toMatchObject({
    scopes_supported: [linksReadScope, linksWriteScope],
  });

  const connectedAfter = Date.now();
  const full = await connect();
  const readGrant = await connect([linksReadScope]);
  const read = readGrant.access_token;
  const write = (await connect([linksWriteScope])).access_token;
  expect(await names(full.access_token)).toEqual([
    "delete_link",
    "list_links",
    "save_link",
  ]);
  expect(await names(read)).toEqual(["list_links"]);
  expect(await names(write)).toEqual(["delete_link", "save_link"]);

  const url = "https://example.com/";
  const saved = await useTool(write, "save_link", { url });
  const { link } = saved.result?.structuredContent as { link: { id: string } };
  expect((await useTool(read, "save_link", { url })).error).toBeDefined();
  expect(
    (await useTool(read, "delete_link", { id: link.id })).error,
  ).toBeDefined();
  expect((await useTool(write, "list_links")).error).toBeDefined();
  expect(
    (await useTool(read, "list_links")).result?.structuredContent,
  ).toMatchObject({ links: [link] });
  expect(
    (await useTool(write, "delete_link", { id: link.id })).result
      ?.structuredContent,
  ).toEqual({ id: link.id });

  const listGrants = async () => {
    const response = await call(mcpGrantsPath, undefined, session);
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(McpGrantList)(await response.json());
  };
  const grants = await listGrants();
  expect(grants).toHaveLength(3);
  for (const grant of grants) {
    expect(grant.createdAt).toBeGreaterThanOrEqual(connectedAfter);
    expect(grant.createdAt).toBeLessThanOrEqual(Date.now());
    expect(grant.expiresAt - grant.createdAt).toBe(30 * 86_400_000);
  }
  const refreshed = await form(mcpOAuth.paths.token, {
    grant_type: "refresh_token",
    client_id: codexClientId,
    resource,
    refresh_token: readGrant.refresh_token,
  });
  expect(refreshed.status, await refreshed.clone().text()).toBe(200);
  expect(await listGrants()).toEqual(grants);

  sqlite.run(
    `UPDATE yielded_oauth_server SET payload = json_set(payload, '$.authorization.scopes', json('["links:read-write","links:delete"]')) WHERE json_array_length(payload, '$.authorization.scopes') = 2`,
  );
  const old = await request("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${full.access_token}` },
  });
  expect(old.status).toBe(401);
  const refresh = await form(mcpOAuth.paths.token, {
    grant_type: "refresh_token",
    client_id: codexClientId,
    resource,
    refresh_token: full.refresh_token,
  });
  expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });
  expect(await listGrants()).toHaveLength(2);
});

it("verifies the signed-in address and changes the password with session invalidation", async () => {
  using sqlite = new Database(":memory:");
  const { call, signIn, cookies, messages, from, setEmailAvailable } =
    await setup(sqlite);
  const newPassword = "example test password phrase";
  const signInResponse = await signIn(password);
  expect(signInResponse.status, await signInResponse.text()).toBe(200);
  const session = cookies(signInResponse);
  const otherSession = cookies(await signIn(password));
  expect(
    await (await call("/api/me", undefined, session)).json(),
  ).toMatchObject({ email, emailVerified: false });
  expect((await call(emailVerificationPath, {})).status).toBe(401);
  expect(
    (await call(emailVerificationPath, {}, session, "https://another.example"))
      .status,
  ).toBe(403);

  const issued = await call(emailVerificationPath, {}, session);
  expect(issued.status, await issued.clone().text()).toBe(200);
  const challenge = (await issued.json()) as object;
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ from, to: email });
  const code = messages[0]?.text.match(/\b\d{6}\b/)?.[0];
  expect(code).toBeDefined();
  const verificationCookie = [session, cookies(issued)].join("; ");
  setEmailAvailable(false);
  const failedSend = await call(emailVerificationPath, {}, verificationCookie);
  expect(failedSend.status).toBe(503);
  expect(cookies(failedSend)).toBe("");
  setEmailAvailable(true);
  const mismatchedSession = [otherSession, cookies(issued)].join("; ");
  expect(
    (
      await call(
        `${emailVerificationPath}/confirm`,
        { ...challenge, code },
        mismatchedSession,
      )
    ).status,
  ).toBe(400);
  const verify = (code: string | undefined) =>
    call(
      `${emailVerificationPath}/confirm`,
      { ...challenge, code },
      verificationCookie,
    );
  expect((await verify(code === "000000" ? "111111" : "000000")).status).toBe(
    400,
  );
  const verified = await verify(code);
  expect(verified.status, await verified.text()).toBe(204);
  expect((await verify(code)).status).toBe(403);
  expect(
    await (await call("/api/me", undefined, session)).json(),
  ).toMatchObject({ email, emailVerified: true });

  const screening = vi.fn(
    async () => new Response("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:0"),
  );
  vi.stubGlobal("fetch", screening);
  try {
    expect(
      (
        await call(
          passwordChangePath,
          { currentPassword: "incorrect", newPassword },
          session,
        )
      ).status,
    ).toBe(400);
    expect(screening).not.toHaveBeenCalled();
    const changed = await call(
      passwordChangePath,
      { currentPassword: password, newPassword },
      session,
    );
    expect(changed.status, await changed.text()).toBe(204);
    expect(cookies(changed)).toContain("__Host-effect-auth-session=");
    expect(messages).toHaveLength(2);
    expect(messages[1]?.text).toContain("password was changed");
    expect((await call("/api/me", undefined, session)).status).toBe(401);
    expect((await call("/api/me", undefined, otherSession)).status).toBe(401);
    expect((await signIn(password)).status).toBe(400);
    expect((await signIn(newPassword)).status).toBe(200);
  } finally {
    vi.unstubAllGlobals();
  }
}, 20_000);

it("changes the sign-in address after password and code verification and keeps owner bootstrap idempotent", async () => {
  using sqlite = new Database(":memory:");
  const { call, signIn, cookies, messages, provision } = await setup(sqlite);
  const session = cookies(await signIn(password));
  const otherSession = cookies(await signIn(password));
  const newEmail = "new-owner@example.net";
  const savedUrl = "https://example.net/bookmark";
  expect((await call(linksPath, { url: savedUrl }, session)).ok).toBe(true);
  const start = (currentPassword: string) =>
    call(
      emailChangePath,
      { email: newEmail.toUpperCase(), currentPassword },
      session,
    );
  const confirm = (id: string, code: string, cookie = session) =>
    call(`${emailChangePath}/confirm`, { id, code }, cookie);

  expect((await start("incorrect")).status).toBe(400);
  expect(messages).toHaveLength(0);

  // Verify the old address first so the redirect also exercises an existing email credential.
  const issueVerification = await call(emailVerificationPath, {}, session);
  const originalCode = messages.pop()?.text.match(/\b\d{6}\b/)?.[0];
  expect(
    (
      await call(
        `${emailVerificationPath}/confirm`,
        { ...(await issueVerification.json()), code: originalCode },
        [session, cookies(issueVerification)].join("; "),
      )
    ).status,
  ).toBe(204);

  const request = await start(password);
  expect(request.status, await request.clone().text()).toBe(200);
  const change = (await request.json()) as { id: string; email: string };
  expect(change.email).toBe(newEmail);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.to).toBe(newEmail);
  const code = messages[0]?.text.match(/\b\d{6}\b/)?.[0] ?? "";
  expect(code).toHaveLength(6);
  expect((await signIn(password, newEmail)).status).toBe(400);
  expect((await signIn(password)).status).toBe(200);
  expect((await confirm(change.id, code, otherSession)).status).toBe(400);
  const wrongCode = code === "000000" ? "111111" : "000000";
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await confirm(change.id, wrongCode)).status).toBe(400);
  }
  expect((await confirm(change.id, code)).status).toBe(400);
  expect(messages).toHaveLength(1);

  const retried = await start(password);
  expect(retried.status).toBe(200);
  const { id } = (await retried.json()) as { id: string };
  const freshCode = messages[1]?.text.match(/\b\d{6}\b/)?.[0] ?? "";
  const outcomes = await Promise.all([
    confirm(id, freshCode),
    confirm(id, freshCode),
  ]);
  const changed = outcomes.find((response) => response.ok);
  expect(changed?.status).toBe(200);
  expect(await changed?.json()).toEqual({ oldAddressNotified: true });
  expect(outcomes.filter((response) => response.ok)).toHaveLength(1);
  expect(messages).toHaveLength(3);
  expect(messages[2]).toMatchObject({ to: email });
  expect(messages[2]?.text).toContain("sign-in email was changed");
  expect((await call("/api/me", undefined, session)).status).toBe(401);
  expect((await call("/api/me", undefined, otherSession)).status).toBe(401);
  expect((await signIn(password)).status).toBe(400);

  await expect(provision({})).resolves.toEqual({ ready: true });
  await expect(provision({ OWNER_EMAIL: email })).resolves.toEqual({
    ready: true,
  });
  const signedIn = await signIn(password, newEmail);
  expect(signedIn.status).toBe(200);
  const newSession = cookies(signedIn);
  expect(
    await (await call(linksPath, undefined, newSession)).json(),
  ).toMatchObject([{ url: savedUrl }]);
  expect(
    await (await call("/api/me", undefined, newSession)).json(),
  ).toMatchObject({
    id: "owner",
    email: newEmail,
    emailVerified: true,
  });
  expect(
    sqlite
      .query(
        "SELECT identifier_value FROM oneapp_auth_emailCredentials WHERE active = 1",
      )
      .get(),
  ).toEqual({ identifier_value: newEmail });
}, 20_000);

it("recovers only a verified address with a single-use link and revokes browser sessions", async () => {
  using sqlite = new Database(":memory:");
  const { call, signIn, cookies, messages, awaitDeliveries, from } =
    await setup(sqlite);
  const session = cookies(await signIn(password));
  const otherSession = cookies(await signIn(password));
  const requestReset = (address = email) =>
    call(passwordResetPath, { email: address });
  const completePath = `${passwordResetPath}/complete`;
  const newPassword = "example replacement password phrase";

  expect((await requestReset()).status).toBe(204);
  expect((await requestReset("unknown@example.net")).status).toBe(204);
  await awaitDeliveries();
  expect(messages).toHaveLength(0);

  const verification = await call(emailVerificationPath, {}, session);
  const code = messages.pop()?.text.match(/\b\d{6}\b/)?.[0];
  const verified = await call(
    `${emailVerificationPath}/confirm`,
    { ...(await verification.json()), code },
    [session, cookies(verification)].join("; "),
  );
  expect(verified.status).toBe(204);

  expect((await requestReset()).status).toBe(204);
  await awaitDeliveries();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ from, to: email });
  const findLink = (body: string) => {
    const link = body.match(/https:\/\/\S+/)?.[0];
    if (!link) throw new Error("Reset email did not include a link");
    return new URL(link);
  };
  const link = findLink(messages[0]!.text);
  expect(link.origin).toBe("https://oneapp.example");
  expect(link.pathname).toBe(resetPasswordPage);
  expect(link.search).toBe("");
  expect(link.hash).toMatch(/^#eal1\./);
  expect((await requestReset()).status).toBe(204);
  await awaitDeliveries();
  expect(messages).toHaveLength(1);

  const landing = await call(link.pathname);
  expect(landing.status).toBe(200);
  expect(landing.headers.get("cache-control")).toBe("no-store");
  expect(landing.headers.get("referrer-policy")).toBe("no-referrer");
  expect(landing.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  expect((await call("/api/me", undefined, session)).status).toBe(200);

  const bodyFor = async (url: URL) => {
    const { reference, secret } = await Effect.runPromise(
      EmailDelivery.parseLinkFragment(Redacted.make(url.hash)),
    );
    return { reference, secret: Redacted.value(secret), newPassword };
  };
  const expired = await bodyFor(link);
  sqlite.run(
    "UPDATE oneapp_auth_proofs SET expires_at = 0 WHERE purpose = 'password-reset'",
  );
  expect((await call(completePath, expired)).status).toBe(400);
  sqlite.run(
    "UPDATE oneapp_auth_proofs SET issued_at = 0 WHERE purpose = 'password-reset'",
  );
  expect((await requestReset()).status).toBe(204);
  await awaitDeliveries();

  const body = await bodyFor(findLink(messages[1]!.text));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:0")),
  );
  try {
    expect(
      (await call(completePath, body, undefined, "https://another.example"))
        .status,
    ).toBe(403);
    expect(
      (
        await call(completePath, {
          ...body,
          secret: (body.secret[0] === "A" ? "B" : "A") + body.secret.slice(1),
        })
      ).status,
    ).toBe(400);
    expect((await call("/api/me", undefined, session)).status).toBe(200);
    const outcome = await call(completePath, body);
    expect(outcome.status, await outcome.text()).toBe(204);
    expect((await call(completePath, body)).status).toBe(400);
    expect((await call("/api/me", undefined, session)).status).toBe(401);
    expect((await call("/api/me", undefined, otherSession)).status).toBe(401);
    expect((await signIn(password)).status).toBe(400);
    expect((await signIn(newPassword)).status).toBe(200);
  } finally {
    vi.unstubAllGlobals();
  }
}, 20_000);

it("authorizes Bitwarden Desktop and binds its code and refresh token to the desktop client", async () => {
  using sqlite = new Database(":memory:");
  const { request, signIn, cookies } = await setup(sqlite);
  const origin = "https://oneapp.example";
  const cookie = cookies(await signIn(password));
  sqlite.run(
    `INSERT INTO personal_vaults (id, owner_id, kdf_salt, kdf_iterations, wrapped_key,
      key_id, wrapped_private_key, public_key, created_at, revision_at)
     VALUES (?, 'owner', ?, 600000, 'wrapped', ?, 'private', 'public', 1, 1)`,
    [crypto.randomUUID(), email, "0".repeat(32)],
  );

  const callback = "bitwarden://sso-callback";
  const browserCallback = `${origin}/sso-connector.html`;
  const state = "s".repeat(64);
  const verifier = "v".repeat(64);
  const authorize = "/identity/connect/authorize";
  const query = new URLSearchParams({
    client_id: "desktop",
    redirect_uri: callback,
    response_type: "code",
    scope: "api offline_access",
    state,
    code_challenge: await digest(verifier),
    code_challenge_method: "S256",
  });
  const start = (params: URLSearchParams, headers = {}) =>
    request(`${authorize}?${params}`, { headers });
  expect((await start(query)).status).toBe(303);
  for (const redirect_uri of [
    browserCallback,
    `${callback}?extra=1`,
    "bitwarden://unrelated",
  ]) {
    const invalid = new URLSearchParams(query);
    invalid.set("redirect_uri", redirect_uri);
    expect((await start(invalid, { cookie })).status).toBe(400);
  }
  const page = await start(query, { cookie });
  expect(page.status).toBe(200);
  const approval = (await page.text()).match(
    /name="approval" value="([^"]+)"/u,
  )?.[1];
  expect(approval).toBeDefined();
  const form = (path: string, body: Record<string, string>, headers = {}) =>
    request(path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(body),
    });
  const approved = await form(
    authorize,
    { approval: approval! },
    { cookie, origin },
  );
  expect(approved.status).toBe(200);
  expect(approved.headers.get("cache-control")).toBe("no-store");
  expect(approved.headers.get("referrer-policy")).toBe("no-referrer");
  const handoff = await approved.text();
  const href = handoff.match(/<a href="([^"]+)">Open Bitwarden<\/a>/u)?.[1];
  expect(href).toBeDefined();
  expect(handoff).not.toContain("Connect vault");
  const target = new URL(href!.replaceAll("&amp;", "&"));
  expect(`${target.protocol}//${target.host}${target.pathname}`).toBe(callback);
  expect(target.searchParams.get("state")).toBe(state);
  const repeatedApproval = await form(
    authorize,
    { approval: approval! },
    { cookie, origin },
  );
  expect(repeatedApproval.status).toBe(400);
  expect(await repeatedApproval.text()).toContain(
    "Start a new Bitwarden sign-in",
  );
  const code = target.searchParams.get("code")!;
  const token = (body: Record<string, string>) =>
    form("/identity/connect/token", { client_id: "desktop", ...body });
  const redeem = {
    grant_type: "authorization_code",
    redirect_uri: callback,
    code,
    code_verifier: verifier,
    deviceIdentifier: crypto.randomUUID(),
    deviceName: "Mac desktop",
  };
  expect(
    (await token({ ...redeem, redirect_uri: browserCallback })).status,
  ).toBe(400);
  expect(
    (
      await token({
        ...redeem,
        client_id: "browser",
        redirect_uri: browserCallback,
      })
    ).status,
  ).toBe(400);
  const exchanged = await token(redeem);
  expect(exchanged.status).toBe(200);
  const issued = (await exchanged.json()) as {
    access_token: string;
    refresh_token: string;
  };
  const checkClient = (jwt: string) =>
    JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString())
      .client_id;
  expect(checkClient(issued.access_token)).toBe("desktop");
  expect((await token(redeem)).status).toBe(400);
  const refresh = {
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
  };
  expect((await token({ ...refresh, client_id: "browser" })).status).toBe(400);
  const refreshed = await token(refresh);
  expect(refreshed.status).toBe(200);
  const successor = (await refreshed.json()) as typeof issued;
  expect(checkClient(successor.access_token)).toBe("desktop");
  expect(
    (
      await request("/api/sync", {
        headers: { authorization: `Bearer ${successor.access_token}` },
      })
    ).status,
  ).toBe(200);
});

it("scopes Bitwarden and web writes to the current account and vault", async () => {
  using sqlite = new Database(":memory:");
  const origin = "https://oneapp.example";
  const {
    call,
    request,
    signIn,
    cookies,
    objects,
    finishWork,
    loseStoredFileResponse,
  } = await setup(sqlite);
  const vaultId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  const otherVaultId = crypto.randomUUID();
  const keyId = "0".repeat(32);
  sqlite
    .query(
      "INSERT INTO accounts (id, active, security_revision) VALUES ('other', 1, '1')",
    )
    .run();
  const seedVault = sqlite.query(`
    INSERT INTO personal_vaults (id, owner_id, kdf_salt, kdf_iterations, wrapped_key, key_id,
       wrapped_private_key, public_key, created_at, revision_at)
    VALUES (?, ?, ?, 600000, 'wrapped', ?, 'wrapped-private', 'public', 1, 1)
  `);
  seedVault.run(vaultId, "owner", email, keyId);
  seedVault.run(otherVaultId, "other", "other@example.net", keyId);
  const encrypted = (bytes: number, fill = 0) => {
    const block = (length: number) =>
      Buffer.alloc(length, fill).toString("base64");
    return `2.${block(16)}|${block(bytes)}|${block(32)}`;
  };
  const legacyDetails = {
    credentials: {
      username: encrypted(16, 40),
      password: encrypted(16, 41),
      uris: [{ uri: encrypted(16, 42), match: null }],
    },
  };
  const seedLogin = sqlite.query(`
    INSERT INTO personal_vault_logins (id, vault_id, name, wrapped_key, details, created_at, revision_at)
    VALUES (?, ?, 'encrypted', 'wrapped', ?, 1, 1)
  `);
  seedLogin.run(itemId, vaultId, JSON.stringify(legacyDetails));
  const otherItemId = crypto.randomUUID();
  seedLogin.run(otherItemId, otherVaultId, JSON.stringify(legacyDetails));

  const callback = `${origin}/sso-connector.html`;
  const verifier = "v".repeat(64);
  const challenge = Base64Url.encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const authorization = "/identity/connect/authorize";
  const authorize = `${authorization}?${new URLSearchParams({
    client_id: "browser",
    redirect_uri: callback,
    response_type: "code",
    scope: "api offline_access",
    state: `${"s".repeat(64)}:clientId=browser`,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })}`;
  const guest = await request(authorize, {});
  expect(guest.status).toBe(303);
  expect(
    new URL(guest.headers.get("location")!).searchParams.get(
      "connectBitwarden",
    ),
  ).toBe("1");

  const cookie = cookies(await signIn(password));
  const otherBrowser = cookies(await signIn(password));
  const page = await request(authorize, { headers: { cookie } });
  expect(page.status).toBe(200);
  const approval = (await page.text()).match(
    /name="approval" value="([^"]+)"/u,
  )?.[1];
  expect(approval).toBeDefined();

  const form = (
    path: string,
    body: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    request(path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(body),
    });
  const consent = { approval: approval! };
  expect(
    (
      await form(authorization, consent, {
        cookie,
        origin: "https://other.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (await form(authorization, consent, { cookie: otherBrowser, origin }))
      .status,
  ).toBe(400);
  const approved = await form(authorization, consent, { cookie, origin });
  expect(approved.status).toBe(303);
  const code = new URL(approved.headers.get("location")!).searchParams.get(
    "code",
  )!;

  const token = (body: Record<string, string>) =>
    form("/identity/connect/token", { client_id: "browser", ...body });
  const codeGrant = {
    grant_type: "authorization_code",
    code,
    redirect_uri: callback,
    deviceIdentifier: "test-device",
  };
  expect(
    (await token({ ...codeGrant, code_verifier: "x".repeat(64) })).status,
  ).toBe(400);
  const redemption = await Promise.all([
    token({ ...codeGrant, code_verifier: verifier }),
    token({ ...codeGrant, code_verifier: verifier }),
  ]);
  expect(redemption.map((response) => response.status).sort()).toEqual([
    200, 400,
  ]);
  const issued = (await redemption.find((response) => response.ok)!.json()) as {
    access_token: string;
    refresh_token: string;
  };
  const sync = (accessToken: string) =>
    request("/api/sync", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  const snapshot = (await (await sync(issued.access_token)).json()) as {
    ciphers: { id: string }[];
  };
  expect(snapshot.ciphers.map(({ id }) => id)).toEqual([itemId]);

  const login = {
    type: 1,
    encryptedFor: vaultId,
    encryptedByKeyId: keyId,
    name: encrypted(16),
    key: encrypted(80),
    notes: encrypted(16, 1),
    favorite: true,
    login: {
      password: encrypted(16, 2),
      uris: [
        { uri: encrypted(32, 3), match: null, uriChecksum: encrypted(48, 4) },
        { uri: encrypted(32, 5), match: 3 },
      ],
    },
  };
  const write = (accessToken: string, body: object, id?: string) =>
    request(id ? `/api/ciphers/${id}` : "/api/ciphers", {
      method: id ? "PUT" : "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
  const save = (accessToken: string, body: object = login) =>
    write(accessToken, body);
  expect((await save("unknown")).status).toBe(401);
  expect(
    (await save(issued.access_token, { ...login, encryptedFor: otherVaultId }))
      .status,
  ).toBe(400);
  expect(
    (
      await save(issued.access_token, {
        ...login,
        encryptedByKeyId: "1".repeat(32),
      })
    ).status,
  ).toBe(409);
  expect(
    (await save(issued.access_token, { ...login, name: "plaintext" })).status,
  ).toBe(400);
  expect(
    (
      await save(issued.access_token, {
        ...login,
        organizationId: otherVaultId,
      })
    ).status,
  ).toBe(400);
  const saves = await Promise.all([
    save(issued.access_token),
    save(issued.access_token),
  ]);
  expect(saves.map((response) => response.status)).toEqual([200, 200]);
  const created = (await saves[0]!.json()) as {
    id: string;
    creationDate: string;
    revisionDate: string;
    deletedDate: string | null;
  };
  expect(created).toMatchObject({
    name: login.name,
    key: login.key,
    notes: login.notes,
    favorite: true,
    login: login.login,
  });
  expect(await saves[1]!.json()).toEqual(created);
  expect(
    sqlite
      .query(
        "SELECT vault_id, revision_at FROM personal_vault_logins WHERE id = ?",
      )
      .get(created.id),
  ).toEqual({
    vault_id: vaultId,
    revision_at: Date.parse(created.revisionDate),
  });
  const revision = await request("/api/accounts/revision-date", {
    headers: { authorization: `Bearer ${issued.access_token}` },
  });
  expect(await revision.json()).toBe(Date.parse(created.revisionDate));
  const afterSave = (await (
    await sync(issued.access_token)
  ).json()) as typeof snapshot;
  expect(afterSave.ciphers.map(({ id }) => id).sort()).toEqual(
    [itemId, created.id].sort(),
  );

  const changed = {
    ...login,
    lastKnownRevisionDate: created.revisionDate,
    login: { ...login.login, password: encrypted(16, 6) },
  };
  const edit = (body: object = changed, id = created.id) =>
    write(issued.access_token, body, id);
  expect((await edit(login)).status).toBe(400);
  expect(
    (await edit({ ...changed, lastKnownRevisionDate: "invalid" })).status,
  ).toBe(400);
  expect((await edit(changed, otherItemId)).status).toBe(404);
  expect((await write("unknown", changed, created.id)).status).toBe(401);
  expect((await edit({ ...changed, encryptedFor: otherVaultId })).status).toBe(
    400,
  );
  const edits = await Promise.all([
    edit(),
    edit({ ...changed, login: { ...login.login, password: encrypted(16, 7) } }),
  ]);
  expect(edits.map((response) => response.status).sort()).toEqual([200, 409]);
  const winner = edits.findIndex((response) => response.ok);
  const edited = (await edits[winner]!.json()) as typeof created;
  expect(edited).toMatchObject({
    id: created.id,
    creationDate: created.creationDate,
    edit: true,
    organizationUseTotp: false,
    login: { ...login.login, password: encrypted(16, 6 + winner) },
  });
  expect(Date.parse(edited.revisionDate)).toBeGreaterThan(
    Date.parse(created.revisionDate),
  );
  expect(await edits[1 - winner]!.json()).toMatchObject({
    error: "stale_cipher",
  });
  expect(await (await save(issued.access_token)).json()).toEqual(edited);
  expect((await edit()).status).toBe(409);
  const afterEdit = (await (
    await sync(issued.access_token)
  ).json()) as typeof snapshot;
  expect(afterEdit.ciphers.find(({ id }) => id === created.id)).toEqual(edited);
  expect(
    sqlite
      .query("SELECT revision_at FROM personal_vaults WHERE id = ?")
      .get(vaultId),
  ).toEqual({ revision_at: Date.parse(edited.revisionDate) });

  const lifecycle = (
    action: "delete" | "restore",
    id = created.id,
    accessToken = issued.access_token,
  ) =>
    request(`/api/ciphers/${id}/${action}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  const readLogin = async () => {
    const snapshot = (await (await sync(issued.access_token)).json()) as {
      ciphers: (typeof created & { login: typeof login.login })[];
    };
    return snapshot.ciphers.find(({ id }) => id === created.id)!;
  };
  expect((await lifecycle("delete", otherItemId)).status).toBe(404);
  expect((await lifecycle("restore", otherItemId)).status).toBe(404);
  expect((await lifecycle("delete", created.id, "unknown")).status).toBe(401);
  expect(await (await lifecycle("restore")).json()).toEqual(edited);

  expect((await lifecycle("delete")).status).toBe(204);
  const trashed = await readLogin();
  expect(trashed).toEqual({
    ...edited,
    deletedDate: trashed.revisionDate,
    revisionDate: trashed.revisionDate,
    permissions: { delete: false, restore: true },
  });
  expect(Date.parse(trashed.revisionDate)).toBeGreaterThan(
    Date.parse(edited.revisionDate),
  );
  expect((await lifecycle("delete")).status).toBe(204);
  expect(await (await save(issued.access_token)).json()).toEqual(trashed);
  for (const revision of [edited.revisionDate, trashed.revisionDate]) {
    const rejected = await edit({
      ...changed,
      lastKnownRevisionDate: revision,
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: "cipher_trashed" });
  }
  expect(await readLogin()).toEqual(trashed);
  expect(
    sqlite
      .query("SELECT revision_at FROM personal_vaults WHERE id = ?")
      .get(vaultId),
  ).toEqual({ revision_at: Date.parse(trashed.revisionDate) });

  const restore = await lifecycle("restore");
  expect(restore.status).toBe(200);
  const restored = (await restore.json()) as typeof created;
  expect(restored).toEqual({ ...edited, revisionDate: restored.revisionDate });
  expect(Date.parse(restored.revisionDate)).toBeGreaterThan(
    Date.parse(trashed.revisionDate),
  );
  expect(await (await lifecycle("restore")).json()).toEqual(restored);
  expect(
    (await edit({ ...changed, lastKnownRevisionDate: edited.revisionDate }))
      .status,
  ).toBe(409);
  expect(await readLogin()).toEqual(restored);
  expect(
    sqlite
      .query("SELECT revision_at FROM personal_vaults WHERE id = ?")
      .get(vaultId),
  ).toEqual({ revision_at: Date.parse(restored.revisionDate) });

  const noteMetadata = {
    favorite: true,
    reprompt: 1,
    fields: [{ type: 0, name: encrypted(16, 11), value: encrypted(32, 11) }],
  };
  const note = {
    type: 2,
    name: encrypted(16, 9),
    key: encrypted(80, 9),
    notes: encrypted(32, 9),
    secureNote: { type: 0 },
    ...noteMetadata,
  };
  for (const invalid of [
    { ...note, notes: "plaintext" },
    { ...note, secureNote: { type: 1 } },
    { ...note, login: login.login },
    { ...note, type: 3 },
  ]) {
    expect((await save(issued.access_token, invalid)).status).toBe(400);
  }
  const noteCreation = await save(issued.access_token, note);
  expect(noteCreation.status).toBe(200);
  const savedNote = (await noteCreation.json()) as typeof created;
  expect(savedNote).toMatchObject({
    type: 2,
    name: note.name,
    notes: note.notes,
    secureNote: { type: 0 },
  });
  expect(savedNote).not.toHaveProperty("login");
  expect(await (await save(issued.access_token, note)).json()).toEqual(
    savedNote,
  );
  const nextNote = {
    ...note,
    notes: encrypted(32, 10),
    lastKnownRevisionDate: savedNote.revisionDate,
  };
  expect(
    (
      await edit(
        { ...note, lastKnownRevisionDate: restored.revisionDate },
        restored.id,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await edit(
        { ...login, lastKnownRevisionDate: savedNote.revisionDate },
        savedNote.id,
      )
    ).status,
  ).toBe(400);
  const noteEdit = await edit(nextNote, savedNote.id);
  expect(noteEdit.status).toBe(200);
  const updatedNote = (await noteEdit.json()) as typeof created;
  expect(updatedNote).toEqual({
    ...savedNote,
    notes: nextNote.notes,
    revisionDate: updatedNote.revisionDate,
  });
  expect(Date.parse(updatedNote.revisionDate)).toBeGreaterThan(
    Date.parse(savedNote.revisionDate),
  );
  expect((await edit(nextNote, savedNote.id)).status).toBe(409);
  const persisted = sqlite
    .query<{ type: number; details: string }, [string]>(
      "SELECT type, details FROM personal_vault_logins WHERE id = ?",
    )
    .get(savedNote.id);
  expect(persisted?.type).toBe(2);
  expect(JSON.parse(persisted!.details)).toEqual({
    ...noteMetadata,
    notes: nextNote.notes,
  });
  const mixedVault = (await (
    await sync(issued.access_token)
  ).json()) as typeof snapshot;
  expect(mixedVault.ciphers).toHaveLength(3);
  expect(mixedVault.ciphers).toContainEqual(restored);
  expect(mixedVault.ciphers).toContainEqual(updatedNote);

  expect((await request(vaultItemsPath, {})).status).toBe(401);
  expect(
    (
      await request(vaultItemsPath, {
        headers: { authorization: `Bearer ${issued.access_token}` },
      })
    ).status,
  ).toBe(401);
  sqlite
    .query("UPDATE personal_vault_logins SET deleted_at = 1 WHERE id = ?")
    .run(itemId);
  const webVault = await request(vaultItemsPath, { headers: { cookie } });
  expect(webVault.status).toBe(200);
  expect(webVault.headers.get("cache-control")).toBe("no-store");
  expect(await webVault.json()).toMatchObject({
    keyId,
    wrappedKey: "wrapped",
    kdfSalt: email,
    kdfIterations: 600_000,
    items: [
      {
        id: restored.id,
        type: 1,
        name: login.name,
        wrappedKey: login.key,
        notes: login.notes,
        requiresMasterPassword: false,
        revision: Date.parse(restored.revisionDate),
        username: null,
        password: encrypted(16, 6 + winner),
        uris: login.login.uris.map(({ uri }) => uri),
      },
      {
        id: updatedNote.id,
        type: 2,
        name: note.name,
        wrappedKey: note.key,
        notes: nextNote.notes,
        requiresMasterPassword: true,
        revision: Date.parse(updatedNote.revisionDate),
      },
    ].sort((a, b) => a.id.localeCompare(b.id)),
    trash: [
      {
        id: itemId,
        type: 1,
        name: "encrypted",
        wrappedKey: "wrapped",
        notes: null,
        requiresMasterPassword: false,
        revision: 1,
        username: legacyDetails.credentials.username,
        password: legacyDetails.credentials.password,
        uris: legacyDetails.credentials.uris.map(({ uri }) => uri),
        details: legacyDetails,
      },
    ],
  });

  const webNote = {
    keyId,
    name: encrypted(16, 12),
    wrappedKey: encrypted(80, 12),
    notes: encrypted(32, 12),
  };
  const postNote = (body = webNote) => call(vaultItemsPath, body, cookie);
  expect((await call(vaultItemsPath, webNote)).status).toBe(401);
  expect(
    (await call(vaultItemsPath, webNote, cookie, "https://other.example"))
      .status,
  ).toBe(403);
  expect(
    (
      await request(vaultItemsPath, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify(webNote),
      })
    ).status,
  ).toBe(403);
  for (const invalid of [
    { ...webNote, name: "plaintext" },
    { ...webNote, notes: "plaintext" },
    { ...webNote, wrappedKey: encrypted(16, 12) },
    { ...webNote, vaultId: otherVaultId },
  ]) {
    expect((await postNote(invalid)).status).toBe(400);
  }
  expect((await postNote({ ...webNote, keyId: "f".repeat(32) })).status).toBe(
    409,
  );
  const savedInWeb = await postNote();
  expect(savedInWeb.status).toBe(201);
  expect(savedInWeb.headers.get("cache-control")).toBe("no-store");
  const webItem = (await savedInWeb.json()) as {
    id: string;
    type: 2;
    revision: number;
  };
  expect(webItem).toMatchObject({
    id: expect.any(String),
    type: 2,
    name: webNote.name,
    wrappedKey: webNote.wrappedKey,
    notes: webNote.notes,
    requiresMasterPassword: false,
    revision: expect.any(Number),
  });
  const vaultRevision = sqlite.query(
    "SELECT revision_at FROM personal_vaults WHERE id = ?",
  );
  const revisionAfterCreate = vaultRevision.get(vaultId);
  expect(await (await postNote()).json()).toEqual(webItem);
  expect(vaultRevision.get(vaultId)).toEqual(revisionAfterCreate);
  expect(vaultRevision.get(otherVaultId)).toEqual({ revision_at: 1 });
  const withWebNote = (await (
    await sync(issued.access_token)
  ).json()) as typeof snapshot;
  expect(withWebNote.ciphers).toHaveLength(4);
  expect(withWebNote.ciphers.find(({ id }) => id === webItem.id)).toMatchObject(
    {
      type: 2,
      name: webNote.name,
      key: webNote.wrappedKey,
      notes: webNote.notes,
      secureNote: { type: 0 },
    },
  );

  const webEdit = {
    keyId,
    expectedRevision: Date.parse(updatedNote.revisionDate),
    name: encrypted(16, 13),
    notes: null,
  };
  const putNote = (
    body: object = webEdit,
    id = savedNote.id,
    headers: HeadersInit = { origin, cookie, "x-effect-auth-csrf": "1" },
  ) => {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("content-type", "application/json");
    return request(vaultItemPath(id), {
      method: "PUT",
      headers: requestHeaders,
      body: JSON.stringify(body),
    });
  };
  expect(
    (
      await putNote(webEdit, savedNote.id, {
        origin,
        "x-effect-auth-csrf": "1",
      })
    ).status,
  ).toBe(401);
  expect(
    (await putNote(webEdit, savedNote.id, { origin, cookie })).status,
  ).toBe(403);
  expect((await putNote(webEdit, "invalid")).status).toBe(400);
  expect((await putNote(webEdit, otherItemId)).status).toBe(404);
  expect((await putNote(webEdit, restored.id)).status).toBe(404);
  for (const invalid of [
    { ...webEdit, name: "plaintext" },
    { ...webEdit, notes: "plaintext" },
    { ...webEdit, expectedRevision: 1.5 },
    { ...webEdit, wrappedKey: webNote.wrappedKey },
  ]) {
    expect((await putNote(invalid)).status).toBe(400);
  }
  expect((await putNote({ ...webEdit, keyId: "f".repeat(32) })).status).toBe(
    409,
  );
  expect(
    (
      await putNote({
        ...webEdit,
        expectedRevision: Date.parse(savedNote.revisionDate),
      })
    ).status,
  ).toBe(409);
  expect(vaultRevision.get(vaultId)).toEqual(revisionAfterCreate);

  const savedEdit = await putNote();
  expect(savedEdit.status).toBe(200);
  expect(savedEdit.headers.get("cache-control")).toBe("no-store");
  const editedInWeb = (await savedEdit.json()) as { revision: number };
  expect(editedInWeb).toMatchObject({
    id: savedNote.id,
    type: 2,
    name: webEdit.name,
    wrappedKey: note.key,
    notes: null,
    requiresMasterPassword: true,
    revision: expect.any(Number),
  });
  expect(editedInWeb.revision).toBeGreaterThan(webEdit.expectedRevision);
  expect(vaultRevision.get(vaultId)).toEqual({
    revision_at: editedInWeb.revision,
  });
  expect(await (await putNote()).json()).toEqual(editedInWeb);
  expect(vaultRevision.get(vaultId)).toEqual({
    revision_at: editedInWeb.revision,
  });
  const syncedEdit = (await (
    await sync(issued.access_token)
  ).json()) as typeof snapshot;
  expect(
    syncedEdit.ciphers.find(({ id }) => id === savedNote.id),
  ).toMatchObject({
    ...noteMetadata,
    name: webEdit.name,
    notes: null,
    key: note.key,
    revisionDate: new Date(editedInWeb.revision).toISOString(),
  });

  expect((await lifecycle("delete", savedNote.id)).status).toBe(204);
  const revisionAfterTrash = vaultRevision.get(vaultId);
  const trashedNoteEdit = await putNote({
    ...webEdit,
    expectedRevision: editedInWeb.revision,
  });
  expect(trashedNoteEdit.status).toBe(409);
  expect(await trashedNoteEdit.json()).toEqual({
    error: "This note is in Trash.",
  });
  expect(vaultRevision.get(vaultId)).toEqual(revisionAfterTrash);

  const webLogin = {
    type: 1,
    keyId,
    name: encrypted(16, 14),
    wrappedKey: encrypted(80, 14),
    username: encrypted(16, 15),
    password: encrypted(32, 16),
    website: {
      uri: encrypted(32, 17),
      uriChecksum: encrypted(48, 18),
    },
  };
  const postLogin = (body: object = webLogin) =>
    call(vaultItemsPath, body, cookie);
  expect((await call(vaultItemsPath, webLogin)).status).toBe(401);
  expect(
    (await call(vaultItemsPath, webLogin, cookie, "https://other.example"))
      .status,
  ).toBe(403);
  for (const invalid of [
    { ...webLogin, name: "plaintext" },
    { ...webLogin, username: "plaintext" },
    { ...webLogin, password: "plaintext" },
    {
      ...webLogin,
      website: { ...webLogin.website, uri: "https://example.net" },
    },
    { ...webLogin, website: { ...webLogin.website, uriChecksum: "plaintext" } },
    { ...webLogin, website: { uri: webLogin.website.uri } },
    { ...webLogin, website: { ...webLogin.website, match: 0 } },
    { ...webLogin, vaultId: otherVaultId },
    { ...webLogin, notes: null },
  ]) {
    expect((await postLogin(invalid)).status).toBe(400);
  }
  expect((await postLogin({ ...webLogin, keyId: "f".repeat(32) })).status).toBe(
    409,
  );
  expect(vaultRevision.get(vaultId)).toEqual(revisionAfterTrash);

  const createdLogin = await postLogin();
  expect(createdLogin.status).toBe(201);
  expect(createdLogin.headers.get("cache-control")).toBe("no-store");
  const savedWebLogin = (await createdLogin.json()) as { id: string };
  expect(savedWebLogin).toMatchObject({
    id: expect.any(String),
    type: 1,
    name: webLogin.name,
    wrappedKey: webLogin.wrappedKey,
    notes: null,
    requiresMasterPassword: false,
    revision: expect.any(Number),
    username: webLogin.username,
    password: webLogin.password,
    uris: [webLogin.website.uri],
  });
  const revisionAfterLogin = vaultRevision.get(vaultId);
  expect(await (await postLogin()).json()).toEqual(savedWebLogin);
  expect(vaultRevision.get(vaultId)).toEqual(revisionAfterLogin);
  expect(vaultRevision.get(otherVaultId)).toEqual({ revision_at: 1 });
  const withWebLogin = (await (
    await sync(issued.access_token)
  ).json()) as typeof snapshot;
  expect(withWebLogin.ciphers).toHaveLength(5);
  expect(
    withWebLogin.ciphers.find(({ id }) => id === savedWebLogin.id),
  ).toMatchObject({
    type: 1,
    name: webLogin.name,
    key: webLogin.wrappedKey,
    login: {
      username: webLogin.username,
      password: webLogin.password,
      uris: [{ ...webLogin.website, match: 1 }],
    },
  });
  const passwordOnly = await postLogin({
    ...webLogin,
    username: null,
    website: null,
  });
  expect(passwordOnly.status).toBe(201);
  expect(await passwordOnly.json()).toMatchObject({
    type: 1,
    username: null,
    password: webLogin.password,
    uris: [],
  });

  const editWebLogin = {
    type: 1,
    keyId,
    expectedRevision: Date.parse(restored.revisionDate),
    name: encrypted(16, 19),
    username: encrypted(16, 20),
    password: encrypted(32, 21),
    website: {
      previousUri: login.login.uris[0]!.uri,
      replacement: webLogin.website,
    },
  };
  const putLogin = (body: object = editWebLogin, id = restored.id) =>
    putNote(body, id);
  expect((await putLogin(editWebLogin, otherItemId)).status).toBe(404);
  expect((await putLogin(editWebLogin, webItem.id)).status).toBe(404);
  expect(
    (await putLogin({ ...editWebLogin, password: "plaintext" })).status,
  ).toBe(400);
  expect(
    (
      await putLogin({
        ...editWebLogin,
        expectedRevision: Date.parse(edited.revisionDate),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await putLogin({
        ...editWebLogin,
        website: { ...editWebLogin.website, previousUri: null },
      })
    ).status,
  ).toBe(409);
  const rotatedInWeb = await putLogin();
  expect(rotatedInWeb.status).toBe(200);
  const editedWebLogin = (await rotatedInWeb.json()) as { revision: number };
  expect(editedWebLogin).toMatchObject({
    id: restored.id,
    name: editWebLogin.name,
    wrappedKey: login.key,
    username: editWebLogin.username,
    password: editWebLogin.password,
    uris: [webLogin.website.uri, login.login.uris[1]!.uri],
  });
  expect(editedWebLogin.revision).toBeGreaterThan(
    editWebLogin.expectedRevision,
  );
  expect(await (await putLogin()).json()).toEqual(editedWebLogin);
  expect(vaultRevision.get(vaultId)).toEqual({
    revision_at: editedWebLogin.revision,
  });
  const afterWebRotation = await readLogin();
  expect(afterWebRotation).toMatchObject({
    id: restored.id,
    key: login.key,
    name: editWebLogin.name,
    notes: login.notes,
    favorite: true,
    login: {
      username: editWebLogin.username,
      password: editWebLogin.password,
      passwordRevisionDate: expect.any(String),
      uris: [{ ...webLogin.website, match: 1 }, login.login.uris[1]],
    },
    passwordHistory: [
      { password: encrypted(16, 6 + winner), lastUsedDate: expect.any(String) },
    ],
  });

  const removeWebsite = {
    ...editWebLogin,
    expectedRevision: editedWebLogin.revision,
    website: { previousUri: webLogin.website.uri, replacement: null },
  };
  const clearedWebsite = await putLogin(removeWebsite);
  expect(clearedWebsite.status).toBe(200);
  const clearedWebLogin = (await clearedWebsite.json()) as { revision: number };
  expect(clearedWebLogin).toMatchObject({ uris: [login.login.uris[1]!.uri] });
  expect(await (await putLogin(removeWebsite)).json()).toEqual(clearedWebLogin);
  const afterClear = await readLogin();
  expect(afterClear).toMatchObject({
    ...afterWebRotation,
    revisionDate: new Date(clearedWebLogin.revision).toISOString(),
    login: { ...afterWebRotation.login, uris: [login.login.uris[1]] },
  });

  const newestPassword = encrypted(32, 22);
  const latestDeviceEdit = await edit({
    ...login,
    name: editWebLogin.name,
    lastKnownRevisionDate: afterClear.revisionDate,
    login: { ...afterClear.login, password: newestPassword },
  });
  expect(latestDeviceEdit.status).toBe(200);
  const beforeStaleSave = await readLogin();
  expect(
    (
      await putLogin({
        ...removeWebsite,
        expectedRevision: clearedWebLogin.revision,
        password: encrypted(16, 23),
      })
    ).status,
  ).toBe(409);
  expect(await readLogin()).toEqual(beforeStaleSave);

  const loginRevision = Date.parse(beforeStaleSave.revisionDate);
  const webLifecycle = (
    action: VaultLifecycleAction,
    expectedRevision: number,
    id = restored.id,
    headers: HeadersInit = { cookie, origin, "x-effect-auth-csrf": "1" },
  ) => {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("content-type", "application/json");
    return request(vaultLifecyclePath(id, action), {
      method: "PUT",
      headers: requestHeaders,
      body: JSON.stringify({ keyId, expectedRevision }),
    });
  };
  const readWebVault = async () =>
    Schema.decodeUnknownSync(VaultSnapshot)(
      await (await request(vaultItemsPath, { headers: { cookie } })).json(),
    );

  expect(
    (
      await webLifecycle("trash", loginRevision, restored.id, {
        origin,
        "x-effect-auth-csrf": "1",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await webLifecycle("trash", loginRevision, restored.id, {
        origin,
        cookie,
      })
    ).status,
  ).toBe(403);
  expect((await webLifecycle("trash", loginRevision, otherItemId)).status).toBe(
    404,
  );
  expect((await webLifecycle("trash", clearedWebLogin.revision)).status).toBe(
    409,
  );
  expect(await readLogin()).toEqual(beforeStaleSave);

  const webTrash = await webLifecycle("trash", loginRevision);
  expect(webTrash.status).toBe(200);
  expect(webTrash.headers.get("cache-control")).toBe("no-store");
  const trashedInWeb = (await webTrash.json()) as {
    id: string;
    revision: number;
  };
  expect(trashedInWeb.id).toBe(restored.id);
  expect(trashedInWeb.revision).toBeGreaterThan(loginRevision);
  expect(await (await webLifecycle("trash", loginRevision)).json()).toEqual(
    trashedInWeb,
  );
  expect(vaultRevision.get(vaultId)).toEqual({
    revision_at: trashedInWeb.revision,
  });
  const trashSnapshot = await readWebVault();
  expect(trashSnapshot.items.some(({ id }) => id === restored.id)).toBe(false);
  expect(trashSnapshot.trash).toContainEqual(trashedInWeb);
  const visibleInBitwardenTrash = await readLogin();
  expect(visibleInBitwardenTrash).toEqual({
    ...beforeStaleSave,
    deletedDate: new Date(trashedInWeb.revision).toISOString(),
    revisionDate: new Date(trashedInWeb.revision).toISOString(),
    permissions: { delete: false, restore: true },
  });
  expect((await webLifecycle("restore", loginRevision)).status).toBe(409);
  expect(vaultRevision.get(vaultId)).toEqual({
    revision_at: trashedInWeb.revision,
  });

  const webRestore = await webLifecycle("restore", trashedInWeb.revision);
  expect(webRestore.status).toBe(200);
  const restoredInWeb = (await webRestore.json()) as typeof trashedInWeb;
  expect(restoredInWeb).toEqual({
    ...trashedInWeb,
    revision: expect.any(Number),
  });
  expect(restoredInWeb.revision).toBeGreaterThan(trashedInWeb.revision);
  expect(
    await (await webLifecycle("restore", trashedInWeb.revision)).json(),
  ).toEqual(restoredInWeb);
  expect((await webLifecycle("trash", loginRevision)).status).toBe(409);
  expect(vaultRevision.get(vaultId)).toEqual({
    revision_at: restoredInWeb.revision,
  });
  expect(await readLogin()).toEqual({
    ...beforeStaleSave,
    revisionDate: new Date(restoredInWeb.revision).toISOString(),
  });
  const restoredSnapshot = await readWebVault();
  expect(restoredSnapshot.items).toContainEqual(restoredInWeb);
  expect(restoredSnapshot.trash.some(({ id }) => id === restored.id)).toBe(
    false,
  );

  const webNoteTrash = await webLifecycle(
    "trash",
    webItem.revision,
    webItem.id,
  );
  expect(webNoteTrash.status).toBe(200);
  const trashedWebNote = (await webNoteTrash.json()) as typeof webItem;
  expect((await readWebVault()).trash).toContainEqual(trashedWebNote);
  const webNoteRestore = await webLifecycle(
    "restore",
    trashedWebNote.revision,
    webItem.id,
  );
  expect(webNoteRestore.status).toBe(200);
  expect((await readWebVault()).items).toContainEqual(
    await webNoteRestore.json(),
  );

  const getCipher = (id: string) =>
    request(`/api/ciphers/${id}`, {
      headers: { authorization: `Bearer ${issued.access_token}` },
    });
  const getWebItem = (id: string) =>
    request(vaultItemPath(id), { headers: { cookie } });
  expect((await getCipher(otherItemId)).status).toBe(404);
  expect((await getWebItem(otherItemId)).status).toBe(404);
  for (const type of extraItemTypes) {
    const { wire, fields } = itemTypes[type];
    const data = Object.fromEntries(
      Object.keys(fields).map((field, index) => [
        field,
        encrypted(16, index + 40),
      ]),
    );
    const firstKey = Object.keys(data)[0]!;
    const properties = {
      name: encrypted(16, type),
      favorite: true,
      notes: encrypted(16, 32),
    };
    const cipher = {
      ...properties,
      type,
      key: encrypted(80, type),
      [wire]: data,
    };
    expect(
      (await save(issued.access_token, { ...cipher, login: {} })).status,
    ).toBe(400);
    expect(
      (
        await save(issued.access_token, {
          ...cipher,
          [wire]: { ...data, invalidField: encrypted(16) },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await save(issued.access_token, {
          ...cipher,
          [wire]: { ...data, [firstKey]: "plaintext" },
        })
      ).status,
    ).toBe(400);

    const saved = await save(issued.access_token, cipher);
    expect(saved.status).toBe(200);
    const original = (await saved.json()) as {
      id: string;
      revisionDate: string;
    };
    expect(await (await getCipher(original.id)).json()).toEqual(original);
    const put = await request(vaultItemPath(original.id), {
      method: "PUT",
      headers: {
        cookie,
        origin,
        "content-type": "application/json",
        "x-effect-auth-csrf": "1",
      },
      body: JSON.stringify({
        keyId,
        type,
        name: properties.name,
        expectedRevision: Date.parse(original.revisionDate),
        details: { data: { [firstKey]: null } },
      }),
    });
    expect(put.status).toBe(200);
    const expectedData = { ...data, [firstKey]: null };
    expect(await (await getWebItem(original.id)).json()).toMatchObject({
      id: original.id,
      type,
      wrappedKey: cipher.key,
      details: { data: expectedData, notes: properties.notes, favorite: true },
    });

    const current = (await (
      await getCipher(original.id)
    ).json()) as typeof original;
    const updated = await write(
      issued.access_token,
      {
        type,
        name: properties.name,
        key: cipher.key,
        favorite: false,
        lastKnownRevisionDate: current.revisionDate,
      },
      original.id,
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      id: original.id,
      type,
      key: cipher.key,
      notes: properties.notes,
      favorite: false,
      [wire]: expectedData,
    });
    const synced = (await (
      await sync(issued.access_token)
    ).json()) as typeof snapshot;
    expect(synced.ciphers.find(({ id }) => id === original.id)).toMatchObject({
      id: original.id,
      [wire]: expectedData,
    });

    const webCreate = await call(
      vaultItemsPath,
      {
        ...properties,
        favorite: undefined,
        notes: undefined,
        keyId,
        type,
        wrappedKey: encrypted(80, type + 16),
        details: { data },
      },
      cookie,
    );
    expect(webCreate.status).toBe(201);
    const { id } = (await webCreate.json()) as { id: string };
    expect(await (await getCipher(id)).json()).toMatchObject({
      id,
      type,
      [wire]: data,
    });
  }

  const folderName = encrypted(16, 81);
  const newFolder = await call(
    vaultFoldersPath,
    { keyId, name: folderName },
    cookie,
  );
  expect(newFolder.status).toBe(201);
  const folder = (await newFolder.json()) as {
    id: string;
    name: string;
    revision: number;
  };
  const authorized = { authorization: `Bearer ${issued.access_token}` };
  const browserJson = {
    cookie,
    origin,
    "content-type": "application/json",
    "x-effect-auth-csrf": "1",
  };
  const deviceJson = { ...authorized, "content-type": "application/json" };
  expect(
    await (
      await call(vaultFoldersPath, { keyId, name: folderName }, cookie)
    ).json(),
  ).toEqual(folder);
  expect(
    await (
      await request(`/api/folders/${folder.id}`, { headers: authorized })
    ).json(),
  ).toMatchObject({ id: folder.id, name: folderName });
  const rename = await request(`/api/folders/${folder.id}`, {
    method: "PUT",
    headers: deviceJson,
    body: JSON.stringify({ name: encrypted(16, 82) }),
  });
  expect(rename.status).toBe(200);
  const renamed = (await rename.json()) as { revisionDate: string };
  const browse = async (id: string) =>
    (await (await getWebItem(id)).json()) as {
      id: string;
      revision: number;
      folderId: string | null;
      archivedAt: number | null;
    };
  const select = (
    ids: { id: string; revision: number }[],
    kind: string,
    extra = {},
  ) =>
    request(vaultBulkPath, {
      method: "PUT",
      headers: browserJson,
      body: JSON.stringify({
        keyId,
        kind,
        items: ids.map(({ id, revision }) => ({ id, revision })),
        ...extra,
      }),
    });
  const otherFolder = crypto.randomUUID();
  sqlite.run("INSERT INTO personal_vault_folders VALUES (?, ?, ?, 1, NULL)", [
    otherFolder,
    otherVaultId,
    encrypted(16, 83),
  ]);
  const original = await browse(webItem.id);
  const editedName = encrypted(16, 84);
  const editNote = (folderId: string | null, expectedRevision: number) =>
    request(vaultItemPath(webItem.id), {
      method: "PUT",
      headers: browserJson,
      body: JSON.stringify({
        keyId,
        type: 2,
        name: editedName,
        details: {},
        expectedRevision,
        folderId,
      }),
    });
  expect((await editNote(otherFolder, original.revision)).status).toBe(409);
  expect(await browse(webItem.id)).toEqual(original);
  const filed = await editNote(folder.id, original.revision);
  expect(filed.status).toBe(200);
  const filedItem = Schema.decodeUnknownSync(VaultItem)(await filed.json());
  expect(filedItem).toMatchObject({ name: editedName, folderId: folder.id });
  expect(await (await editNote(folder.id, original.revision)).json()).toEqual(
    filedItem,
  );
  expect((await editNote(null, original.revision)).status).toBe(409);
  expect(await (await editNote(null, filedItem.revision)).json()).toMatchObject(
    {
      folderId: null,
    },
  );
  const initial = await Promise.all([browse(restored.id), browse(webItem.id)]);
  const beforeMove = vaultRevision.get(vaultId);
  expect(
    (await select(initial, "move", { folderId: otherFolder })).status,
  ).toBe(404);
  expect(
    (
      await select([initial[0]!, { id: otherItemId, revision: 1 }], "move", {
        folderId: folder.id,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await select([initial[0]!, { ...initial[1]!, revision: 1 }], "move", {
        folderId: folder.id,
      })
    ).status,
  ).toBe(409);
  expect(vaultRevision.get(vaultId)).toEqual(beforeMove);
  const move = await select(initial, "move", { folderId: folder.id });
  expect(move.status).toBe(200);
  const moved = await Promise.all([browse(restored.id), browse(webItem.id)]);
  expect(moved.every(({ folderId }) => folderId === folder.id)).toBe(true);
  expect(moved[0]!.revision).toBe(moved[1]!.revision);
  expect((await select(initial, "move", { folderId: folder.id })).status).toBe(
    200,
  );
  expect(vaultRevision.get(vaultId)).toEqual({
    revision_at: moved[0]!.revision,
  });

  const archive = await request("/api/ciphers/archive", {
    method: "PUT",
    headers: deviceJson,
    body: JSON.stringify({ ids: moved.map(({ id }) => id) }),
  });
  expect(archive.status).toBe(200);
  const archived = await Promise.all([browse(restored.id), browse(webItem.id)]);
  expect(archived.every(({ archivedAt }) => archivedAt !== null)).toBe(true);
  expect((await select(archived, "unarchive")).status).toBe(200);
  const unarchived = await Promise.all([
    browse(restored.id),
    browse(webItem.id),
  ]);
  expect(unarchived.every(({ archivedAt }) => archivedAt === null)).toBe(true);

  const partial = await request(`/api/ciphers/${restored.id}/partial`, {
    method: "PUT",
    headers: deviceJson,
    body: JSON.stringify({ folderId: folder.id }),
  });
  expect(partial.status).toBe(200);
  expect(await partial.json()).toMatchObject({
    favorite: true,
    folderId: folder.id,
  });

  const removeFolder = (expectedRevision: number) =>
    request(vaultFolderPath(folder.id), {
      method: "DELETE",
      headers: browserJson,
      body: JSON.stringify({ keyId, expectedRevision }),
    });
  expect((await removeFolder(folder.revision)).status).toBe(409);
  expect((await removeFolder(Date.parse(renamed.revisionDate))).status).toBe(
    204,
  );
  const detached = await Promise.all([browse(restored.id), browse(webItem.id)]);
  expect(detached.every(({ folderId }) => folderId === null)).toBe(true);
  expect(detached[0]!.revision).toBeGreaterThan(unarchived[0]!.revision);
  expect((await readWebVault()).folders).toEqual([]);

  expect((await select(detached, "purge")).status).toBe(409);
  expect((await select(detached, "trash")).status).toBe(200);
  const trashSelection = await Promise.all([
    browse(restored.id),
    browse(webItem.id),
  ]);
  const bulkRestore = await request("/api/ciphers/restore", {
    method: "PUT",
    headers: deviceJson,
    body: JSON.stringify({ ids: trashSelection.map(({ id }) => id) }),
  });
  expect(bulkRestore.status).toBe(200);
  expect((await readWebVault()).items).toEqual(
    expect.arrayContaining(
      trashSelection.map(({ id }) => expect.objectContaining({ id })),
    ),
  );
  const chosen = [await browse(webItem.id)];
  expect((await select(chosen, "trash")).status).toBe(200);
  const toPurge = [await browse(webItem.id)];
  expect((await select(toPurge, "purge")).status).toBe(200);
  const purgeRevision = vaultRevision.get(vaultId);
  expect((await select(toPurge, "purge")).status).toBe(200);
  expect(vaultRevision.get(vaultId)).toEqual(purgeRevision);
  expect((await getCipher(webItem.id)).status).toBe(404);

  const importBody = {
    folders: [{ name: encrypted(16, 96) }],
    ciphers: [
      { ...login, name: encrypted(16, 97) },
      {
        type: 3,
        name: encrypted(16, 98),
        key: encrypted(80, 8),
        card: { response: null, number: encrypted(16, 99) },
        archivedDate: "2026-01-01T00:00:00Z",
      },
    ],
    folderRelationships: [{ key: 1, value: 0 }],
  };
  const importDevice = (body: object) =>
    request("/api/ciphers/import", {
      method: "POST",
      headers: deviceJson,
      body: JSON.stringify(body),
    });
  const revisionBeforeImport = vaultRevision.get(vaultId);
  expect(
    (
      await importDevice({
        ...importBody,
        folderRelationships: [{ key: 2, value: 0 }],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await importDevice({
        ...importBody,
        folderRelationships: [
          { key: 1, value: 0 },
          { key: 1, value: 0 },
        ],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await importDevice({
        ...importBody,
        ciphers: [login, { ...login, login: { fido2Credentials: [{}] } }],
      })
    ).status,
  ).toBe(400);
  expect(vaultRevision.get(vaultId)).toEqual(revisionBeforeImport);

  sqlite.exec(`CREATE TRIGGER fail_test_import BEFORE INSERT ON personal_vault_logins
    WHEN NEW.type = 3 BEGIN SELECT RAISE(ABORT, 'fixture import failure'); END;`);
  expect((await importDevice(importBody)).status).toBe(503);
  expect(vaultRevision.get(vaultId)).toEqual(revisionBeforeImport);
  expect((await readWebVault()).folders).toEqual([]);
  expect(sqlite.query("SELECT id FROM personal_vault_imports").all()).toEqual(
    [],
  );
  sqlite.exec("DROP TRIGGER fail_test_import");

  const importedResponses = await Promise.all([
    importDevice(importBody),
    call(vaultImportPath, { keyId, ...importBody }, cookie),
  ]);
  expect(importedResponses.map((response) => response.status)).toEqual([
    204, 200,
  ]);
  expect(await importedResponses[1]!.json()).toEqual({ items: 2, folders: 1 });
  const imported = await readWebVault();
  expect(imported.folders).toHaveLength(1);
  expect(
    imported.items.filter(({ name }) => name === importBody.ciphers[0]!.name),
  ).toHaveLength(1);
  expect(
    imported.items.find(({ name }) => name === importBody.ciphers[1]!.name),
  ).toMatchObject({
    type: 3,
    folderId: imported.folders[0]!.id,
    archivedAt: Date.parse("2026-01-01T00:00:00Z"),
  });
  const revisionAfterImport = vaultRevision.get(vaultId);
  expect((await importDevice(importBody)).status).toBe(204);
  expect(vaultRevision.get(vaultId)).toEqual(revisionAfterImport);

  const fileItem = await browse(restored.id);
  const initialFile = {
    keyId,
    expectedRevision: fileItem.revision,
    name: encrypted(16, 100),
    wrappedKey: encrypted(80, 100),
    size: 65,
  };
  const reserve = (item: string, input = initialFile) =>
    call(vaultAttachmentsPath(item), input, cookie);
  expect((await reserve(otherItemId)).status).toBe(404);
  expect(
    (
      await reserve(fileItem.id, {
        ...initialFile,
        size: vaultAttachmentLimit + 1,
      })
    ).status,
  ).toBe(400);
  expect(
    (await reserve(fileItem.id, { ...initialFile, size: 66 })).status,
  ).toBe(413);
  expect(
    (await reserve(fileItem.id, { ...initialFile, expectedRevision: 1 }))
      .status,
  ).toBe(409);
  const oldPending = crypto.randomUUID().replaceAll("-", "");
  sqlite.run(
    `INSERT INTO personal_vault_attachments
    (id, item_id, name, wrapped_key, size, item_key, revision_at, expires_at, create_digest)
    SELECT ?, id, ?, ?, ?, wrapped_key, revision_at, ?, ? FROM personal_vault_logins WHERE id = ?`,
    [
      oldPending,
      initialFile.name,
      initialFile.wrappedKey,
      vaultAttachmentQuota - 64,
      Date.now() + 60_000,
      "quota fixture",
      fileItem.id,
    ],
  );
  expect((await reserve(fileItem.id)).status).toBe(413);
  sqlite.run(
    "UPDATE personal_vault_attachments SET expires_at = 0 WHERE id = ?",
    [oldPending],
  );
  const reserved = await reserve(fileItem.id);
  expect(reserved.status).toBe(201);
  const file = (await reserved.json()) as { id: string };
  expect(await (await reserve(fileItem.id)).json()).toMatchObject({
    id: file.id,
  });
  const wireFilePath = `/api/ciphers/${fileItem.id}/attachment/${file.id}`;
  const webFilePath = vaultAttachmentPath(fileItem.id, file.id);
  expect((await request(wireFilePath, { headers: authorized })).status).toBe(
    404,
  );
  expect(await (await getCipher(fileItem.id)).json()).toMatchObject({
    attachments: [],
  });
  const bytes = new Uint8Array(65).fill(7);
  bytes[0] = 2;
  const putFile = (content: Uint8Array<ArrayBuffer>) =>
    request(webFilePath, {
      method: "PUT",
      headers: { ...browserJson, "content-type": "application/octet-stream" },
      body: content,
    });
  expect((await putFile(bytes.subarray(0, 64))).status).toBe(413);
  loseStoredFileResponse();
  expect((await putFile(bytes)).status).toBeGreaterThanOrEqual(500);
  expect(objects.size).toBe(1);
  expect(await (await getCipher(fileItem.id)).json()).toMatchObject({
    attachments: [],
  });
  expect((await putFile(bytes)).status).toBe(204);
  expect((await putFile(bytes)).status).toBe(204);
  expect(objects.size).toBe(1);
  const revised = await browse(fileItem.id);
  expect(revised.revision).toBeGreaterThan(fileItem.revision);
  expect(await (await getCipher(fileItem.id)).json()).toMatchObject({
    attachments: [
      {
        id: file.id,
        fileName: initialFile.name,
        key: initialFile.wrappedKey,
        size: "65",
        url: "",
      },
    ],
  });
  const rewrapped = {
    ...login,
    key: encrypted(80, 104),
    lastKnownRevisionDate: new Date(revised.revision).toISOString(),
    attachments: { [file.id]: encrypted(16, 105) },
    attachments2: {
      [file.id]: {
        fileName: encrypted(16, 105),
        key: encrypted(80, 105),
        lastKnownRevisionDate: new Date(revised.revision).toISOString(),
      },
    },
  };
  const staleRewrap = await write(
    issued.access_token,
    {
      ...rewrapped,
      lastKnownRevisionDate: new Date(fileItem.revision).toISOString(),
    },
    fileItem.id,
  );
  expect(staleRewrap.status).toBe(409);
  const savedRewrap = await write(issued.access_token, rewrapped, fileItem.id);
  expect(savedRewrap.status).toBe(200);
  expect(await savedRewrap.json()).toMatchObject({
    key: rewrapped.key,
    attachments: [
      {
        id: file.id,
        fileName: rewrapped.attachments2[file.id]!.fileName,
        key: rewrapped.attachments2[file.id]!.key,
      },
    ],
  });
  expect(await (await getCipher(fileItem.id)).json()).toMatchObject({
    attachments: [{ id: file.id, key: rewrapped.attachments2[file.id]!.key }],
  });
  const fileMetadata = await request(wireFilePath, { headers: authorized });
  expect(fileMetadata.status).toBe(200);
  const transfer = (await fileMetadata.json()) as { url: string };
  expect(
    new Uint8Array(await (await request(transfer.url, {})).arrayBuffer()),
  ).toEqual(bytes);
  expect(
    (await request(transfer.url.replace(file.id, "f".repeat(32)), {})).status,
  ).toBe(401);
  const realNow = Date.now();
  const later = vi.spyOn(Date, "now").mockReturnValue(realNow + 61_000);
  try {
    expect((await request(transfer.url, {})).status).toBe(401);
  } finally {
    later.mockRestore();
  }
  sqlite.run(
    "UPDATE bitwarden_device_sessions SET security_revision = 'revoked fixture' WHERE vault_id = ?",
    [vaultId],
  );
  try {
    expect((await request(transfer.url, {})).status).toBe(404);
  } finally {
    sqlite.run(
      "UPDATE bitwarden_device_sessions SET security_revision = (SELECT security_revision FROM accounts WHERE id = 'owner') WHERE vault_id = ?",
      [vaultId],
    );
  }
  expect(
    (
      await request(vaultAttachmentPath(otherItemId, file.id), {
        headers: { cookie },
      })
    ).status,
  ).toBe(404);
  expect((await request(webFilePath, {})).status).toBe(401);
  expect((await select([await browse(fileItem.id)], "trash")).status).toBe(200);
  expect(
    new Uint8Array(
      await (await request(webFilePath, { headers: { cookie } })).arrayBuffer(),
    ),
  ).toEqual(bytes);
  expect((await select([await browse(fileItem.id)], "purge")).status).toBe(200);
  await finishWork();
  expect(objects.has(file.id)).toBe(false);
  expect((await request(transfer.url, {})).status).toBe(404);
  expect(
    sqlite
      .query("SELECT id FROM personal_vault_attachment_cleanup WHERE id = ?")
      .all(file.id),
  ).toEqual([]);

  const refresh = {
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
  };
  const rotated = await Promise.all([token(refresh), token(refresh)]);
  expect(rotated.map((response) => response.status)).toEqual([200, 200]);
  const successor = (await rotated[0]!.json()) as typeof issued;
  expect(
    ((await rotated[1]!.json()) as typeof issued).refresh_token ===
      successor.refresh_token,
  ).toBe(true);
  expect(successor.refresh_token !== issued.refresh_token).toBe(true);
  expect((await sync(successor.access_token)).status).toBe(200);
  expect((await request("/api/sync", { method: "POST" })).status).toBe(405);
  sqlite.query("UPDATE bitwarden_device_sessions SET retry_until = 0").run();
  expect((await sync(issued.access_token)).status).toBe(401);
  expect((await token(refresh)).status).toBe(400);

  sqlite
    .query(
      "UPDATE accounts SET security_revision = 'changed' WHERE id = 'owner'",
    )
    .run();
  expect((await sync(successor.access_token)).status).toBe(401);
  expect((await postNote()).status).toBe(401);
  expect((await putNote()).status).toBe(401);
  expect((await postLogin()).status).toBe(401);
  expect((await webLifecycle("trash", restoredInWeb.revision)).status).toBe(
    401,
  );
  expect((await save(successor.access_token)).status).toBe(401);
  expect(
    (await lifecycle("restore", created.id, successor.access_token)).status,
  ).toBe(401);
  expect(
    (await write(successor.access_token, changed, created.id)).status,
  ).toBe(401);
  expect(
    (await token({ ...refresh, refresh_token: successor.refresh_token }))
      .status,
  ).toBe(400);
  expect((await token(refresh)).status).toBe(400);
}, 20_000);

it("lists Bitwarden devices and revokes all grants for just the selected installation", async () => {
  using sqlite = new Database(":memory:");
  const { request, signIn, cookies } = await setup(sqlite);
  const origin = "https://oneapp.example";
  const cookie = cookies(await signIn(password));
  const list = (session?: string) =>
    request(bitwardenDevicesPath, {
      headers: session ? { cookie: session } : {},
    });
  const revoke = (id: string, from = origin) =>
    request(`${bitwardenDevicesPath}/${id}`, {
      method: "DELETE",
      headers: { cookie, origin: from, "x-effect-auth-csrf": "1" },
    });
  expect((await list()).status).toBe(401);
  expect(await (await list(cookie)).json()).toEqual([]);

  const vaultId = crypto.randomUUID();
  const otherVaultId = crypto.randomUUID();
  sqlite
    .query(
      "INSERT INTO accounts (id, active, security_revision) VALUES ('other', 1, '1')",
    )
    .run();
  const vault = sqlite.query(`
    INSERT INTO personal_vaults (id, owner_id, kdf_salt, kdf_iterations, wrapped_key,
      key_id, wrapped_private_key, public_key, created_at, revision_at)
    VALUES (?, ?, ?, 600000, 'wrapped', 'key', 'private', 'public', 1, 1)
  `);
  vault.run(vaultId, "owner", email);
  vault.run(otherVaultId, "other", "other@example.net");

  const now = Date.now();
  const seedDevice = async (
    vault: string,
    id: string,
    name: string | null,
    expiresAt: number,
  ) => {
    const access = randomSecret();
    const refresh = randomSecret();
    const previousAccess = randomSecret();
    const previousRefresh = randomSecret();
    const [
      accessDigest,
      refreshDigest,
      previousAccessDigest,
      previousRefreshDigest,
    ] = await Promise.all([
      digest(access),
      digest(refresh),
      digest(previousAccess),
      digest(previousRefresh),
    ]);
    sqlite
      .query(
        `
      INSERT INTO bitwarden_device_sessions (id, vault_id, device_id, device_name, security_revision,
        email, email_verified, expires_at, generation, issued_at, access_digest, refresh_digest,
        previous_access_digest, previous_refresh_digest, retry_until)
      SELECT ?, v.id, ?, ?, a.security_revision, v.kdf_salt, 1, ?, 1, ?, ?, ?, ?, ?, ?
      FROM personal_vaults v JOIN accounts a ON a.id = v.owner_id WHERE v.id = ?
    `,
      )
      .run(
        crypto.randomUUID(),
        id,
        name,
        expiresAt,
        Math.floor(now / 1000),
        accessDigest,
        refreshDigest,
        previousAccessDigest,
        previousRefreshDigest,
        now + 60_000,
        vault,
      );
    return { access, refresh, previousAccess, previousRefresh };
  };
  const expires = now + deviceLifetimeMillis;
  const target = "selected-chrome";
  const other = "other-browser";
  const [current, older, survivor, foreign] = await Promise.all([
    seedDevice(vaultId, target, "Chrome", expires),
    seedDevice(vaultId, target, "Older connection", expires - 2_000),
    seedDevice(vaultId, other, null, expires - 1_000),
    seedDevice(otherVaultId, target, "Another account", expires + 1_000),
    seedDevice(vaultId, "expired", "Expired", now - 1),
  ]);
  const listed = await list(cookie);
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  expect(await listed.json()).toEqual([
    { id: target, name: "Chrome", createdAt: now },
    { id: other, name: "Browser extension", createdAt: now - 1_000 },
  ]);

  const sync = (access: string) =>
    request("/api/sync", { headers: { authorization: `Bearer ${access}` } });
  const refresh = (credential: string) =>
    request("/identity/connect/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "browser",
        grant_type: "refresh_token",
        refresh_token: credential,
      }),
    });
  expect((await revoke(target, "https://other.example")).status).toBe(403);
  expect((await sync(current.access)).status).toBe(200);
  expect((await sync(current.previousAccess)).status).toBe(200);
  expect((await revoke(target)).status).toBe(204);
  expect((await revoke(target)).status).toBe(204);
  expect(await (await list(cookie)).json()).toEqual([
    { id: other, name: "Browser extension", createdAt: now - 1_000 },
  ]);
  for (const grant of [current, older]) {
    for (const access of [grant.access, grant.previousAccess]) {
      expect((await sync(access)).status).toBe(401);
    }
    for (const credential of [grant.refresh, grant.previousRefresh]) {
      const rejected = await refresh(credential);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ error: "invalid_grant" });
    }
  }
  expect((await sync(survivor.access)).status).toBe(200);
  expect((await sync(foreign.access)).status).toBe(200);
  expect((await refresh(survivor.refresh)).status).toBe(200);
});

it("initializes a personal vault once and preserves its keys on retries and concurrent setup", async () => {
  using sqlite = new Database(":memory:");
  const { call, cookies, signIn } = await setup(sqlite);
  const [first, second] = await Promise.all([
    createVaultSetup("first test vault password", email),
    createVaultSetup("second test vault password", email),
  ]);
  expect((await call(vaultSetupPath)).status).toBe(401);
  expect((await call(vaultSetupPath, first)).status).toBe(401);

  const cookie = cookies(await signIn(password));
  expect(await (await call(vaultSetupPath, undefined, cookie)).json()).toEqual({
    initialized: false,
    kdfSalt: email,
  });
  expect(
    (await call(vaultSetupPath, first, cookie, "https://other.example")).status,
  ).toBe(403);
  expect(
    (
      await call(
        vaultSetupPath,
        { ...first, kdfSalt: "other@example.net" },
        cookie,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call(
        vaultSetupPath,
        { ...first, masterPassword: "unexpected" },
        cookie,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        vaultSetupPath,
        { ...first, publicKey: "A".repeat(392) },
        cookie,
      )
    ).status,
  ).toBe(400);

  const [left, right] = await Promise.all([
    call(vaultSetupPath, first, cookie),
    call(vaultSetupPath, second, cookie),
  ]);
  expect([left.status, right.status].sort()).toEqual([201, 409]);
  const winner = left.status === 201 ? first : second;
  const loser = left.status === 201 ? second : first;
  expect((await call(vaultSetupPath, winner, cookie)).status).toBe(204);
  expect((await call(vaultSetupPath, loser, cookie)).status).toBe(409);
  expect(await (await call(vaultSetupPath, undefined, cookie)).json()).toEqual({
    initialized: true,
  });

  const vaults = sqlite
    .query("SELECT owner_id, key_id, wrapped_key FROM personal_vaults")
    .all();
  expect(vaults).toEqual([
    { owner_id: "owner", key_id: winner.keyId, wrapped_key: winner.wrappedKey },
  ]);
  expect(sqlite.query("SELECT id FROM personal_vault_logins").all()).toEqual(
    [],
  );
});
import type {
  EmailMessageBuilder,
  RateLimit,
  SendEmail,
} from "@cloudflare/workers-types";
