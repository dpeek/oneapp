import { expect, it, vi } from "@effect/vitest";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createECDH, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { generateVAPIDKeys } from "web-push";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { mailMessagePage } from "../inbox-contract.ts";
import { ensureDefaultMailbox, mailDatabase } from "./mailbox.ts";
import { indexMail, type IndexedMail } from "./mail-index.ts";
import { deliverMailPush, type PushEnv } from "./push-delivery.ts";
import { recoverIncomingMail } from "./inbox.ts";

const ece = createRequire(import.meta.resolve("web-push"))("http_ece") as {
  decrypt(
    data: Buffer,
    parameters: {
      version: string;
      privateKey: ReturnType<typeof createECDH>;
      authSecret: Buffer;
    },
  ): Buffer;
};
const now = Date.now();
const id = "0-0000000000001-00000000-0000-4000-8000-000000000001.eml";
const mail: IndexedMail = {
  id,
  folder: "inbox",
  timestamp: now,
  from: "sender@example.com",
  to: "mail@example.com",
  subject: "Private subject",
  unread: true,
  messageIds: [],
  notifyIncoming: true,
};

const setup = async (sqlite: Database) => {
  const root = new URL("../../drizzle/", import.meta.url).pathname;
  for (const file of Array.from(
    new Bun.Glob("*/migration.sql").scanSync(root),
  ).sort())
    sqlite.exec(await Bun.file(root + file).text());
  sqlite.exec("PRAGMA foreign_keys = ON");
  let failBatch = false;
  const statement = (sql: string, values: SQLQueryBindings[] = []) => ({
    bind: (...values: SQLQueryBindings[]) => statement(sql, values),
    execute: () => ({ results: sqlite.query(sql).all(...values) }),
    run: async () => ({ results: sqlite.query(sql).all(...values) }),
    first: async () => sqlite.query(sql).get(...values),
    all: async () => ({ results: sqlite.query(sql).all(...values) }),
  });
  const db = mailDatabase(
    {
      prepare: statement,
      batch: async (statements: ReturnType<typeof statement>[]) =>
        sqlite.transaction(() => {
          const results = statements.map((statement) => statement.execute());
          if (failBatch) {
            failBatch = false;
            throw new Error("Simulated D1 failure");
          }
          return results;
        })(),
    } as unknown as D1Database,
    "personal",
  );
  sqlite.exec(
    "INSERT INTO accounts (id, active, security_revision) VALUES ('owner', 1, '1')",
  );
  await ensureDefaultMailbox(db);
  sqlite
    .query(
      `INSERT INTO oneapp_auth_sessions (session_id, subject_id, digest, security_revision, issued_at, expires_at, absolute_expires_at, record)
    VALUES ('session', 'owner', 'digest', '1', ?, ?, ?, '{}')`,
    )
    .run(now - 1000, now + 86_400_000, now + 86_400_000);
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const auth = randomBytes(16);
  const subscribe = (id = "device", created = now - 1000) =>
    sqlite
      .query(
        `INSERT INTO push_subscriptions
    (id, account_id, mailbox_id, session_id, security_revision, endpoint, p256dh, auth, created_at)
    VALUES (?, 'owner', 'personal', 'session', '1', ?, ?, ?, ?)`,
      )
      .run(
        id,
        `https://web.push.apple.com/${id}`,
        receiver.getPublicKey().toString("base64url"),
        auth.toString("base64url"),
        created,
      );
  subscribe();
  const vapid = generateVAPIDKeys();
  const env: PushEnv = {
    DB: db,
    PUSH_PUBLIC_KEY: vapid.publicKey,
    PUSH_PRIVATE_KEY: vapid.privateKey,
    PUSH_SUBJECT: "mailto:mail@example.com",
  };
  const queued = () =>
    sqlite.query("SELECT * FROM mail_push_outbox").all() as {
      attempts: number;
      completed_at: number | null;
      next_attempt_at: number;
      subscription_id: string;
    }[];
  return {
    db,
    env,
    subscribe,
    queued,
    receiver,
    auth,
    fail: () => {
      failBatch = true;
    },
  };
};

it("atomically indexes and enqueues once per subscribed device, without replaying imports or old mail", async () => {
  using sqlite = new Database(":memory:");
  const store = await setup(sqlite);
  store.subscribe("second");
  store.subscribe("later", now + 1000);
  store.fail();
  await expect(indexMail(store.db, mail)).rejects.toThrow("D1 failure");
  expect(store.queued()).toHaveLength(0);
  expect(sqlite.query("SELECT id FROM mail_index_messages").all()).toHaveLength(
    0,
  );
  await indexMail(store.db, mail);
  await indexMail(store.db, mail);
  expect(store.queued()).toHaveLength(2);
  await indexMail(store.db, {
    ...mail,
    id: "import",
    notifyIncoming: undefined,
  });
  await indexMail(store.db, {
    ...mail,
    id: "old",
    timestamp: now - 2 * 86_400_000,
  });
  await indexMail(store.db, { ...mail, id: "sent", folder: "sent" });
  expect(store.queued()).toHaveLength(2);
});

it("recovers the live-mail marker from R2 after failed indexing, without alerting for historical mail", async () => {
  using sqlite = new Database(":memory:");
  const store = await setup(sqlite);
  store.fail();
  await expect(indexMail(store.db, mail)).rejects.toThrow();
  sqlite.exec(
    "INSERT INTO mail_index_scans (mailbox_id, folder, cursor, scanned_at, ready) VALUES ('personal', 'inbox:list-mail', 'historical-import-cursor', 1, 1)",
  );
  const bytes = new TextEncoder().encode(
    "From: sender@example.com\r\nTo: mail@example.com\r\nSubject: Private subject\r\n\r\nBody",
  );
  const object = {
    key: id,
    uploaded: new Date(now),
    size: bytes.length,
    customMetadata: {
      initialUnread: "1",
      notifyIncoming: "1",
      envelopeFrom: mail.from,
      envelopeTo: mail.to,
      subject: mail.subject,
    },
  };
  const inbox = {
    list: async (options: { prefix?: string; cursor?: string }) => {
      expect(options.prefix).toBe("0-");
      expect(options.cursor).toBeUndefined();
      return { objects: [object], truncated: false };
    },
    get: async () => ({
      ...object,
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.buffer,
    }),
  } as unknown as R2Bucket;
  await recoverIncomingMail({
    DB: store.db,
    INBOX_MESSAGES: inbox,
    SENT_MESSAGES: {
      list: async () => ({ objects: [], truncated: false }),
    } as unknown as R2Bucket,
    mailboxAddresses: [],
  } as unknown as Parameters<typeof recoverIncomingMail>[0]);
  expect(store.queued()).toHaveLength(1);
  await recoverIncomingMail({
    DB: store.db,
    INBOX_MESSAGES: inbox,
    SENT_MESSAGES: {
      list: async () => ({ objects: [], truncated: false }),
    } as unknown as R2Bucket,
    mailboxAddresses: [],
  } as unknown as Parameters<typeof recoverIncomingMail>[0]);
  expect(store.queued()).toHaveLength(1);
});

it("sends an encrypted privacy-preserving alert with the real message route, then never resends a completed job", async () => {
  using sqlite = new Database(":memory:");
  const store = await setup(sqlite);
  await indexMail(store.db, mail);
  const send = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toMatch(/^vapid /);
    expect(headers.get("content-encoding")).toBe("aes128gcm");
    expect(init?.redirect).toBe("manual");
    const payload = JSON.parse(
      ece
        .decrypt(Buffer.from(init!.body as Uint8Array), {
          version: "aes128gcm",
          privateKey: store.receiver,
          authSecret: store.auth,
        })
        .toString(),
    );
    expect(payload.url).toBe(mailMessagePage("all", id));
    expect(payload.title).toBe("New mail");
    expect(JSON.stringify(payload)).not.toContain(mail.subject);
    expect(JSON.stringify(payload)).not.toContain(mail.from);
    return new Response(null, { status: 201 });
  }) as unknown as typeof fetch;
  await deliverMailPush(store.env, send, now + 1000);
  expect(store.queued()[0]?.completed_at).toBe(now + 1000);
  await deliverMailPush(store.env, send, now + 2000);
  expect(send).toHaveBeenCalledTimes(1);
});

it("retries transient failures, respects Retry-After, and removes expired subscriptions", async () => {
  using sqlite = new Database(":memory:");
  const store = await setup(sqlite);
  await indexMail(store.db, mail);
  const send = vi.fn(
    async () =>
      new Response(null, { status: 503, headers: { "retry-after": "120" } }),
  ) as unknown as typeof fetch;
  await deliverMailPush(store.env, send, now + 1000);
  expect(store.queued()[0]).toMatchObject({
    attempts: 1,
    completed_at: null,
    next_attempt_at: now + 121_000,
  });
  await deliverMailPush(store.env, send, now + 61_000);
  expect(send).toHaveBeenCalledTimes(1);
  await deliverMailPush(
    store.env,
    async () => new Response(null, { status: 410 }),
    now + 121_000,
  );
  expect(store.queued()).toHaveLength(0);
  expect(sqlite.query("SELECT id FROM push_subscriptions").all()).toHaveLength(
    0,
  );
});

it("leases jobs across overlapping deliveries and recovers abandoned leases", async () => {
  using sqlite = new Database(":memory:");
  const store = await setup(sqlite);
  await indexMail(store.db, mail);
  const send = vi.fn(async () => {
    await deliverMailPush(
      store.env,
      async () => {
        throw new Error("Lease was not respected");
      },
      now + 1000,
    );
    return new Response(null, { status: 201 });
  }) as unknown as typeof fetch;
  await Promise.all([
    deliverMailPush(store.env, send, now + 1000),
    deliverMailPush(store.env, send, now + 1000),
  ]);
  expect(send).toHaveBeenCalledTimes(1);
  sqlite
    .query(
      "UPDATE mail_push_outbox SET completed_at = NULL, lease = 'crashed', next_attempt_at = ?",
    )
    .run(now + 60_000);
  await deliverMailPush(store.env, send, now + 60_000);
  expect(send).toHaveBeenCalledTimes(2);
});

it("does not follow push service redirects or mark them delivered", async () => {
  using sqlite = new Database(":memory:");
  const store = await setup(sqlite);
  await indexMail(store.db, mail);
  const send = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.redirect).toBe("manual");
    return new Response(null, {
      status: 307,
      headers: { location: "https://untrusted.example/push" },
    });
  });
  await deliverMailPush(store.env, send, now + 1000);
  expect(send).toHaveBeenCalledTimes(1);
  expect(store.queued()[0]).toMatchObject({
    completed_at: null,
    next_attempt_at: now + 61_000,
  });
});

it("logs useful delivery errors without exposing endpoints or signing keys", async () => {
  using sqlite = new Database(":memory:");
  const store = await setup(sqlite);
  await indexMail(store.db, mail);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await deliverMailPush(
      store.env,
      async (endpoint) => {
        throw new Error(
          `Network failed for ${endpoint} with ${store.env.PUSH_PRIVATE_KEY}`,
        );
      },
      now + 1000,
    );
    expect(warn).toHaveBeenCalledWith("Mail push delivery unavailable", {
      attempt: 1,
      stage: "send",
      reason: "Network failed for [redacted] with [redacted]",
    });
    expect(store.queued()[0]?.completed_at).toBeNull();
  } finally {
    warn.mockRestore();
  }
});

it.each(["logout", "password-change", "expired", "read", "deleted"])(
  "suppresses pending alerts after %s",
  async (change) => {
    using sqlite = new Database(":memory:");
    const store = await setup(sqlite);
    await indexMail(store.db, mail);
    if (change === "logout") sqlite.exec("DELETE FROM oneapp_auth_sessions");
    if (change === "password-change")
      sqlite.exec("UPDATE accounts SET security_revision = '2'");
    if (change === "expired")
      sqlite.exec("UPDATE oneapp_auth_sessions SET expires_at = 0");
    if (change === "read")
      sqlite.exec("UPDATE mail_index_messages SET unread = 0");
    if (change === "deleted")
      sqlite.exec("UPDATE mail_index_messages SET deleted = 1");
    const send = vi.fn(
      async () => new Response(null, { status: 201 }),
    ) as unknown as typeof fetch;
    await deliverMailPush(store.env, send, now + 1000);
    expect(send).not.toHaveBeenCalled();
  },
);
