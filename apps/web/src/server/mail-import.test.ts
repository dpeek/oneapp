import { expect, it } from "@effect/vitest";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { D1Database, R2Bucket, R2Object } from "@cloudflare/workers-types";
import { ingestRawMail, type MailImportMetadata } from "./mail-import.ts";
import {
  completeImportedConversations,
  importCompletionPolicy,
} from "./mail-import-completion.ts";
import {
  indexMail,
  readThread,
  removeIndexedMail,
  setInboxUnread,
  setThreadArchived,
} from "./mail-index.ts";
import { describeStoredRawMail, storedMailTimestamp } from "./raw-mail.ts";
import {
  describeStoredSent,
  listSent,
  readSent,
  readSentReplyTarget,
} from "./sent-mail.ts";
import { attachmentResponse } from "./mail-attachments.ts";

const metadata: MailImportMetadata = {
  source: {
    account: "icloud:owner@icloud.com",
    mailbox: "Archive",
    uidValidity: 123,
    uid: 7,
  },
  folder: "inbox",
  archived: true,
  timestamp: Date.UTC(2020, 0, 2),
  flags: ["\\Seen", "\\Flagged"],
};
const raw = (id = "root", references = "") =>
  new TextEncoder().encode(
    [
      "From: Alice <alice@example.com>",
      "To: mail@dpeek.com",
      "Cc: other@example.com",
      "Subject: Historical message",
      "Date: Thu, 02 Jan 2020 00:00:00 +0000",
      `Message-ID: <${id}@example.com>`,
      ...(references ? [`References: <${references}@example.com>`] : []),
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="test"',
      "",
      "--test",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Original text",
      "--test",
      'Content-Type: application/octet-stream; name="test.bin"',
      'Content-Disposition: attachment; filename="test.bin"',
      "Content-Transfer-Encoding: base64",
      "",
      "AAECA/8=",
      "--test--",
      "",
    ].join("\r\n"),
  );

const bucket = () => {
  const objects = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; object: R2Object }
  >();
  let failAfterPut = false;
  const api = {
    put: async (
      id: string,
      bytes: Uint8Array<ArrayBuffer>,
      options: { customMetadata: Record<string, string> },
    ) => {
      if (objects.has(id)) return null;
      const object = {
        key: id,
        size: bytes.byteLength,
        customMetadata: options.customMetadata,
        uploaded: new Date(),
      } as R2Object;
      objects.set(id, { bytes: bytes.slice(), object });
      if (failAfterPut) {
        failAfterPut = false;
        throw new Error("Lost R2 response");
      }
      return object;
    },
    head: async (id: string) => objects.get(id)?.object ?? null,
    get: async (
      id: string,
      options?: { range?: { offset: number; length: number } },
    ) => {
      const stored = objects.get(id);
      if (!stored) return null;
      const range = options?.range;
      const bytes = range
        ? stored.bytes.slice(range.offset, range.offset + range.length)
        : stored.bytes.slice();
      return {
        ...stored.object,
        body: new Response(bytes).body,
        arrayBuffer: async () => bytes.buffer,
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      };
    },
    list: async () => ({
      objects: [...objects.values()].map(({ object }) => object),
      truncated: false,
    }),
  };
  return {
    api: api as unknown as R2Bucket,
    objects,
    loseResponse: () => {
      failAfterPut = true;
    },
  };
};

const setup = async (sqlite: Database) => {
  const root = new URL("../../drizzle/", import.meta.url).pathname;
  for (const file of Array.from(
    new Bun.Glob("*/migration.sql").scanSync(root),
  ).sort())
    sqlite.exec(await Bun.file(root + file).text());
  const statement = (sql: string, values: SQLQueryBindings[] = []) => ({
    bind: (...values: SQLQueryBindings[]) => statement(sql, values),
    execute: () => ({ results: sqlite.query(sql).all(...values) }),
    run: async () => ({ results: sqlite.query(sql).all(...values) }),
    first: async () => sqlite.query(sql).get(...values),
    all: async () => ({ results: sqlite.query(sql).all(...values) }),
  });
  let failBatch = false;
  const DB = {
    prepare: statement,
    batch: async (statements: ReturnType<typeof statement>[]) =>
      sqlite.transaction(() => {
        const results = statements.map((statement) => statement.execute());
        if (failBatch) {
          failBatch = false;
          throw new Error("D1 failure");
        }
        return results;
      })(),
  } as unknown as D1Database;
  const inbox = bucket();
  const sent = bucket();
  return {
    DB,
    INBOX_MESSAGES: inbox.api,
    SENT_MESSAGES: sent.api,
    inbox,
    sent,
    failNextBatch: () => {
      failBatch = true;
    },
  };
};

it("preserves original bytes, dates, flags, people and archive state through index rebuild", async () => {
  using sqlite = new Database(":memory:");
  const store = await setup(sqlite);
  const { id } = await ingestRawMail(store, metadata, raw());
  expect(store.inbox.objects.get(id)?.bytes).toEqual(raw());
  expect(
    sqlite
      .query("SELECT timestamp, unread, archived FROM mail_index_messages")
      .get(),
  ).toEqual({ timestamp: metadata.timestamp, unread: 0, archived: 1 });
  const saved = store.inbox.objects.get(id)!.object;
  expect(storedMailTimestamp(saved)).toBe(metadata.timestamp);
  const described = await describeStoredRawMail(
    store.INBOX_MESSAGES,
    saved,
    "inbox",
  );
  expect(described?.people?.members.map((person) => person.address)).toContain(
    "other@example.com",
  );
  sqlite.exec("DELETE FROM mail_index_messages; DELETE FROM mail_index_keys;");
  await indexMail(store.DB, described!);
  expect(
    sqlite.query("SELECT timestamp, archived FROM mail_index_messages").get(),
  ).toEqual({ timestamp: metadata.timestamp, archived: 1 });
  const attachment = await attachmentResponse(
    store.INBOX_MESSAGES,
    id,
    0,
    false,
  );
  expect(new Uint8Array(await attachment!.arrayBuffer())).toEqual(
    new Uint8Array([0, 1, 2, 3, 255]),
  );
  const receipt = sqlite
    .query("SELECT metadata, completed_at FROM mail_imports")
    .get() as { metadata: string; completed_at: number };
  expect(JSON.parse(receipt.metadata)).toEqual(metadata);
  expect(receipt.completed_at).toBeGreaterThan(0);
});

it("retries after a lost R2 response and an atomic D1 failure without duplicates", async () => {
  using sqlite = new Database(":memory:");
  const store = await setup(sqlite);
  store.inbox.loseResponse();
  await expect(ingestRawMail(store, metadata, raw())).rejects.toThrow(
    "Lost R2 response",
  );
  store.failNextBatch();
  await expect(ingestRawMail(store, metadata, raw())).rejects.toThrow(
    "D1 failure",
  );
  expect(sqlite.query("SELECT completed_at FROM mail_imports").get()).toEqual({
    completed_at: null,
  });
  expect(sqlite.query("SELECT id FROM mail_index_messages").all()).toEqual([]);
  const recovered = await ingestRawMail(
    store,
    { ...metadata, archived: false, flags: [] },
    raw(),
  );
  expect(recovered.status).toBe("imported");
  expect(store.inbox.objects.size).toBe(1);
  expect(
    sqlite.query("SELECT unread, archived FROM mail_index_messages").get(),
  ).toEqual({ unread: 0, archived: 1 });
});

it("makes concurrent retries idempotent and preserves subsequent user changes and deletion", async () => {
  using sqlite = new Database(":memory:");
  const store = await setup(sqlite);
  const [left, right] = await Promise.all([
    ingestRawMail(store, metadata, raw()),
    ingestRawMail(store, metadata, raw()),
  ]);
  expect(left.id).toBe(right.id);
  expect(store.inbox.objects.size).toBe(1);
  await setInboxUnread(store.DB, left.id, true);
  await setThreadArchived(store.DB, left.id, false);
  expect((await ingestRawMail(store, metadata, raw())).status).toBe("skipped");
  expect(
    sqlite.query("SELECT unread, archived FROM mail_index_messages").get(),
  ).toEqual({ unread: 1, archived: 0 });
  await removeIndexedMail(store.DB, "inbox", left.id);
  store.inbox.objects.delete(left.id);
  expect((await ingestRawMail(store, metadata, raw())).status).toBe("skipped");
  expect(store.inbox.objects.size).toBe(0);
});

it("rejects changed bytes for a source identity and isolates UIDVALIDITY epochs", async () => {
  using sqlite = new Database(":memory:");
  const store = await setup(sqlite);
  const first = await ingestRawMail(store, metadata, raw());
  await expect(
    ingestRawMail(store, metadata, raw("different")),
  ).rejects.toThrow("different message bytes");
  const second = await ingestRawMail(
    store,
    { ...metadata, source: { ...metadata.source, uidValidity: 124 } },
    raw("different"),
  );
  expect(first.id).not.toBe(second.id);
  expect(store.inbox.objects.size).toBe(2);
});

it("imports raw Sent messages, reads them and threads them with incoming mail", async () => {
  using sqlite = new Database(":memory:");
  const store = await setup(sqlite);
  const incoming = await ingestRawMail(store, metadata, raw());
  const sentMetadata = {
    ...metadata,
    folder: "sent" as const,
    archived: false,
    source: { ...metadata.source, mailbox: "Sent Messages" },
    timestamp: metadata.timestamp + 1000,
  };
  const sent = await ingestRawMail(store, sentMetadata, raw("reply", "root"));
  expect(store.sent.objects.get(sent.id)?.bytes).toEqual(raw("reply", "root"));
  expect(
    (await readThread(store.DB, incoming.id)).messages.map(({ id }) => id),
  ).toEqual([incoming.id, sent.id]);
  expect(
    (await listSent(store.SENT_MESSAGES, undefined)).messages[0],
  ).toMatchObject({ id: sent.id, sentAt: sentMetadata.timestamp });
  expect(await readSent(store.SENT_MESSAGES, sent.id)).toMatchObject({
    text: "Original text",
    preview: "complete",
    sentAt: sentMetadata.timestamp,
  });
  expect(
    (await readSentReplyTarget(store.SENT_MESSAGES, sent.id))?.headers?.[
      "In-Reply-To"
    ],
  ).toBe("<reply@example.com>");
  expect(
    (
      await describeStoredSent(
        store.SENT_MESSAGES,
        store.sent.objects.get(sent.id)!.object,
      )
    )?.messageIds,
  ).toEqual(["<root@example.com>", "<reply@example.com>"]);
});

it("rejects invalid metadata and missing headers before creating import state", async () => {
  using sqlite = new Database(":memory:");
  const store = await setup(sqlite);
  await expect(
    ingestRawMail(store, { ...metadata, timestamp: -1 }, raw()),
  ).rejects.toThrow();
  await expect(
    ingestRawMail(store, metadata, new TextEncoder().encode("not email")),
  ).rejects.toThrow("headers");
  expect(sqlite.query("SELECT * FROM mail_imports").all()).toEqual([]);
  expect(store.inbox.objects.size).toBe(0);
});

it("completes whole inactive read threads after import, protects exceptions and preserves decisions on retry", async () => {
  using sqlite = new Database(":memory:");
  const store = await setup(sqlite);
  const asOf = "2026-11-23T00:00:00.000Z";
  const policy = importCompletionPolicy(asOf);
  let uid = 0;
  const add = (
    name: string,
    references = "",
    overrides: Partial<MailImportMetadata> = {},
  ) =>
    ingestRawMail(
      store,
      {
        ...metadata,
        source: { ...metadata.source, mailbox: "INBOX", uid: ++uid },
        timestamp: policy.cutoff - 86_400_000,
        archived: false,
        flags: ["\\Seen"],
        ...overrides,
      },
      raw(name, references),
    );
  const old = await add("old");
  const oldMember = await add("old-child", "old");
  const replied = await add("replied");
  await add("recent-sent", "replied", {
    folder: "sent",
    timestamp: Date.parse(asOf) - 1000,
  });
  const unread = await add("unread", "", { flags: [] });
  await add("read-child", "unread");
  const flagged = await add("flagged");
  await add("flagged-sent", "flagged", {
    folder: "sent",
    flags: ["\\Seen", "\\Flagged"],
  });
  const boundary = await add("boundary", "", { timestamp: policy.cutoff });
  const archived = await add("archived", "", { archived: true });
  const outside = await add("outside");
  const unselected = await add("unselected", "outside");
  const deletedThread = await add("deleted-thread");
  const deletedUnread = await add("deleted-unread", "deleted-thread", {
    flags: [],
  });
  sqlite
    .query("UPDATE mail_index_messages SET deleted = 1 WHERE id = ?")
    .run(deletedUnread.id);
  const sources = sqlite
    .query("SELECT source_id AS id FROM mail_imports WHERE message_id <> ?")
    .all(unselected.id) as { id: string }[];
  const request = {
    id: "snapshot:mapping",
    asOf,
    sourceIds: sources.map((row) => row.id),
  };
  const state = (id: string) =>
    sqlite
      .query("SELECT archived FROM mail_index_messages WHERE id = ?")
      .get(id);
  await expect(
    completeImportedConversations(store.DB, {
      ...request,
      sourceIds: [...request.sourceIds, "0".repeat(64)],
    }),
  ).rejects.toThrow("Finish importing");
  store.failNextBatch();
  await expect(
    completeImportedConversations(store.DB, request),
  ).rejects.toThrow("D1 failure");
  expect(sqlite.query("SELECT * FROM mail_import_completions").all()).toEqual(
    [],
  );
  expect(state(old.id)).toEqual({ archived: 0 });
  const result = await completeImportedConversations(store.DB, request);
  expect(result).toMatchObject({
    completedConversations: 2,
    keptInInbox: 5,
    alreadyComplete: 1,
    policy,
  });
  for (const id of [old.id, oldMember.id, deletedThread.id, archived.id])
    expect(state(id)).toEqual({ archived: 1 });
  for (const id of [replied.id, unread.id, flagged.id, boundary.id, outside.id])
    expect(state(id)).toEqual({ archived: 0 });
  expect(result.decisions.map((d) => d.reason)).toContain("outside-import");
  expect(result.decisions.map((d) => d.reason)).toContain("unread");
  expect(result.decisions.map((d) => d.reason)).toContain("flagged");
  // Simulate a manual reopen and a later reply before retrying the same import.
  sqlite
    .query("UPDATE mail_index_messages SET archived = 0 WHERE id = ?")
    .run(old.id);
  await add("new-mail", "deleted-thread", { timestamp: Date.parse(asOf) });
  const replay = await completeImportedConversations(store.DB, request);
  expect(replay).toEqual(result);
  expect(state(old.id)).toEqual({ archived: 0 });
  expect(state(deletedThread.id)).toEqual({ archived: 0 });
  await expect(
    completeImportedConversations(store.DB, {
      ...request,
      asOf: "2026-11-24T00:00:00.000Z",
    }),
  ).rejects.toThrow("policy changed");
});

it("refreshes cached sender heuristics from original mail without resetting mailbox state", async () => {
  using sqlite = new Database(":memory:");
  const store = await setup(sqlite);
  const bytes = new TextEncoder().encode(
    new TextDecoder()
      .decode(raw())
      .replace(
        "Alice <alice@example.com>",
        "Example <shipment-tracking@example.com>",
      ),
  );
  const { id } = await ingestRawMail(store, metadata, bytes);
  await setInboxUnread(store.DB, id, true);
  sqlite.query("UPDATE mail_index_messages SET people = ? WHERE id = ?").run(
    JSON.stringify({
      sender: { address: "shipment-tracking@example.com", name: "Example" },
      members: [],
    }),
    id,
  );
  sqlite.exec(
    await Bun.file(
      new URL(
        "../../drizzle/20261123101915_mail_sender_heuristics/migration.sql",
        import.meta.url,
      ),
    ).text(),
  );
  expect(
    sqlite.query("SELECT people FROM mail_index_messages WHERE id = ?").get(id),
  ).toEqual({ people: null });
  await indexMail(
    store.DB,
    (await describeStoredRawMail(
      store.INBOX_MESSAGES,
      store.inbox.objects.get(id)!.object,
      "inbox",
    ))!,
  );
  const row = sqlite
    .query(
      "SELECT people, unread, archived, timestamp FROM mail_index_messages WHERE id = ?",
    )
    .get(id) as {
    people: string;
    unread: number;
    archived: number;
    timestamp: number;
  };
  expect(JSON.parse(row.people).sender.appearance).toEqual({
    kind: "service",
    mode: "auto",
    domain: "example.com",
  });
  expect(row).toMatchObject({
    unread: 1,
    archived: 1,
    timestamp: metadata.timestamp,
  });
});
