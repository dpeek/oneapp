import {
  senderAppearanceRules,
  setSenderAppearance,
} from "./mail-sender-appearance.ts";
import {
  trashMail,
  restoreMail,
  listTrash,
  collectMailTrash,
  emptyMailTrash,
  mailRetentionMs,
} from "./mail-trash.ts";
import {
  ensureDefaultMailbox,
  mailDatabase,
  mailboxBucket,
  mailboxIdentities,
  requireMailbox,
  resolveMailRecipient,
  scopeMailStore,
} from "./mailbox.ts";
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
  conversationCursor,
  readThread,
  removeIndexedMail,
  setInboxUnread,
  setThreadArchived,
  inboxUnread,
  listConversations,
  setSenderRule,
  scanMail,
} from "./mail-index.ts";
import { mailPeople } from "./mail-people.ts";
import { describeStoredRawMail, storedMailTimestamp } from "./raw-mail.ts";
import {
  describeStoredSent,
  listSent,
  readSent,
  readSentReplyTarget,
} from "./sent-mail.ts";
import { attachmentResponse } from "./mail-attachments.ts";
import { deleteContact, restoreContact, writeProfile } from "./people-store.ts";

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
    delete: async (ids: string | string[]) => {
      for (const id of Array.isArray(ids) ? ids : [ids]) objects.delete(id);
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
  sqlite.exec(
    "INSERT INTO accounts (id, active, security_revision) VALUES ('owner', 1, '1')",
  );
  await ensureDefaultMailbox(DB);
  const inbox = bucket();
  const sent = bucket();
  return {
    DB: mailDatabase(DB, "personal"),
    INBOX_MESSAGES: inbox.api,
    SENT_MESSAGES: sent.api,
    inbox,
    sent,
    failNextBatch: () => {
      failBatch = true;
    },
  };
};

it("advances the mailbox version for committed mail and directory changes", async () => {
  using sqlite = new Database(":memory:");
  const store = await setup(sqlite);
  const { DB } = store;
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.run(
    "INSERT INTO mailboxes (id, owner_account_id, name) VALUES ('other', 'owner', 'Other')",
  );
  const versions = sqlite.query<{ version: number }, [string]>(
    "SELECT version FROM mail_changes WHERE mailbox_id = ?",
  );
  const version = (mailbox = DB.mailboxId) =>
    versions.get(mailbox)?.version ?? 0;
  const advances = async <A>(change: () => Promise<A>) => {
    const previous = version();
    const result = await change();
    expect(version()).toBeGreaterThan(previous);
    return result;
  };

  store.failNextBatch();
  await expect(ingestRawMail(store, metadata, raw())).rejects.toThrow(
    "D1 failure",
  );
  expect(version()).toBe(0);
  const { id } = await ingestRawMail(store, metadata, raw());
  expect(version()).toBeGreaterThan(0);
  const imported = version();
  await ingestRawMail(store, metadata, raw());
  sqlite.run("UPDATE mail_index_messages SET body_preview = 'Cached preview'");
  expect(version()).toBe(imported);

  await advances(() => setInboxUnread(DB, id, true));
  await advances(() => setThreadArchived(DB, id, false));
  await advances(() => trashMail(DB, id));
  await advances(() => restoreMail(DB, id));
  await advances(() =>
    setSenderRule(DB, { address: "alice@example.com", priority: "noise" }),
  );
  await advances(() =>
    setSenderAppearance(DB, { address: "alice@example.com", mode: "service" }),
  );
  expect(version("other")).toBe(0);

  const person = crypto.randomUUID();
  const address = "alice@example.com";
  const revision = await advances(() =>
    writeProfile(DB, person, undefined, "Alice", [address], null),
  );
  const updated = await advances(() =>
    writeProfile(DB, person, revision!, "Alice", ["new@example.com"], null),
  );
  expect(updated).toBeTruthy();
  const deletion = await advances(() => deleteContact(DB, person, updated!));
  if (deletion.status !== "ok")
    throw new Error("Fixture contact could not be deleted");
  await advances(() => restoreContact(DB, deletion.receipt));
  expect(version("other")).toBe(4);
});

it("filters conversation members and unread state before paging in mailbox order", async () => {
  using sqlite = new Database(":memory:");
  const { DB } = await setup(sqlite);
  const contact = (
    kind: "person" | "company",
    email?: string,
    domain?: string,
  ) => {
    const id = crypto.randomUUID();
    sqlite.run("INSERT INTO people (id, kind, revision) VALUES (?, ?, ?)", [
      id,
      kind,
      id,
    ]);
    if (email)
      sqlite.run(
        "INSERT INTO person_addresses (email, person_id) VALUES (?, ?)",
        [email, id],
      );
    if (domain)
      sqlite.run(
        "INSERT INTO company_domains (domain, company_id) VALUES (?, ?)",
        [domain, id],
      );
    return id;
  };
  const ownAddress = "mail@cedar.example.com";
  const alexAddress = "alex@team.cedar.example.com";
  const joAddress = "jo@example.net";
  const pineEmail = "sales@pine.example.net";
  const alex = contact("person", alexAddress);
  const jo = contact("person", joAddress);
  const cedar = contact("company", undefined, "cedar.example.com");
  const pine = contact("company", undefined, "pine.example.net");
  const add = async (
    subject: string,
    from: string,
    options: {
      folder?: "inbox" | "sent";
      to?: string;
      cc?: string;
      thread?: string;
      unread?: boolean;
      archived?: boolean;
      listMail?: boolean;
    } = {},
  ) => {
    const folder = options.folder ?? "inbox";
    const to = options.to ?? ownAddress;
    const id = `0-8199999999999-${crypto.randomUUID()}${folder === "inbox" ? ".eml" : ""}`;
    await indexMail(DB, {
      id,
      folder,
      from,
      to,
      subject,
      timestamp: ++time,
      messageIds: [options.thread ?? subject],
      unread: options.unread ?? true,
      initialArchived: options.archived,
      listMail: options.listMail,
      people: mailPeople(
        (name) => (name === "cc" ? options.cc : undefined),
        from,
        to,
      ),
    });
    return id;
  };
  let time = 1_800_000_000_000;
  const first = await add("Alex at Cedar", alexAddress);
  await add("Alex at Cedar", alexAddress, { unread: false });
  await add("Jo at Pine", joAddress, { thread: "Jo and Pine" });
  await add("Pine reply", ownAddress, {
    folder: "sent",
    to: pineEmail,
    thread: "Jo and Pine",
    unread: false,
  });
  await add("Jo at Cedar, read", joAddress, {
    cc: "liaison@cedar.example.com",
    unread: false,
  });
  await add("Jo at similar domain", joAddress, {
    cc: "liaison@notcedar.example.com",
  });
  await add("Unknown Cedar sender", "unlinked@cedar.example.com", {
    cc: alexAddress,
  });
  await add("Alex archive", alexAddress, { archived: true });
  await add("Alex sent only", ownAddress, {
    folder: "sent",
    to: alexAddress,
  });
  const legacy = await add("Jo with legacy participants", ownAddress, {
    folder: "sent",
    to: `Jo <${joAddress}>, Pine <${pineEmail}>`,
    unread: false,
  });
  sqlite.run("UPDATE mail_index_messages SET people = NULL WHERE id = ?", [
    legacy,
  ]);
  for (let index = 0; index < 22; index++)
    await add(`Unrelated ${index}`, "outsider@example.net");

  const cursor = { timestamp: null, id: "" };
  const filters = {
    status: "unread",
    people: [alex, jo],
    companies: [cedar, pine],
  } as const;
  const list = (
    view: "inbox" | "noise" | "archive" | "all",
    status: "unread" | "read" = "unread",
  ) =>
    listConversations(DB, cursor, view, { ...filters, status }, [ownAddress]);
  const subjects = ({
    messages,
  }: Awaited<ReturnType<typeof listConversations>>) =>
    messages.map(({ subject }) => subject);
  expect(
    subjects(await listConversations(DB, cursor, "noise")).filter((subject) =>
      subject.startsWith("Unrelated "),
    ),
  ).toHaveLength(20);
  expect(subjects(await list("inbox"))).toEqual([
    "Jo at Pine",
    "Alex at Cedar",
  ]);
  expect(subjects(await list("noise"))).toEqual(["Unknown Cedar sender"]);
  expect(subjects(await list("archive"))).toEqual(["Alex archive"]);
  expect(subjects(await list("all", "read"))).toEqual([
    "Jo with legacy participants",
    "Alex sent only",
    "Jo at Cedar, read",
  ]);
  await setInboxUnread(DB, first, false);
  expect(subjects(await list("inbox"))).toEqual(["Jo at Pine"]);
  for (let index = 0; index < 20; index++)
    await add(`Alex ${index}`, alexAddress);
  const filtered = await list("inbox");
  expect(subjects(filtered)).toEqual(
    Array.from({ length: 20 }, (_, index) => `Alex ${19 - index}`),
  );
  const next = conversationCursor(filtered.cursor ?? undefined, "inbox");
  expect(filtered.cursor).not.toBeNull();
  expect(
    subjects(
      await listConversations(DB, next!, "inbox", filters, [ownAddress]),
    ),
  ).toEqual(["Jo at Pine"]);
});

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
  expect(sqlite.query("SELECT id FROM items").all()).toEqual([]);
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

it("preserves conversation item identity and tags through replies, merges and Trash", async () => {
  using sqlite = new Database(":memory:");
  const { DB } = await setup(sqlite);
  sqlite.exec("PRAGMA foreign_keys = ON");
  const message = (
    id: string,
    timestamp: number,
    messageIds: string[],
    subject: string,
  ) => ({
    id,
    timestamp,
    messageIds,
    subject,
    folder: "inbox" as const,
    from: "alice@example.com",
    to: "mail@example.com",
    unread: false,
  });
  const first = message("100.eml", 10, ["first@example.com"], "First subject");
  const second = message(
    "200.eml",
    20,
    ["second@example.com"],
    "Other subject",
  );
  const reply = message(
    "300.eml",
    30,
    ["first@example.com"],
    "Re: First subject",
  );
  const bridge = message(
    "400.eml",
    40,
    ["first@example.com", "second@example.com"],
    "Re: First subject",
  );
  const items = () =>
    sqlite
      .query<
        {
          id: string;
          title: string;
          revision: string;
          created: number;
          updated: number;
        },
        []
      >(
        `
    SELECT i.id, i.title, i.revision, i.created_at AS created, i.updated_at AS updated
    FROM items i JOIN mail_conversations c ON c.account_id = i.account_id AND c.item_id = i.id
    ORDER BY i.created_at
  `,
      )
      .all();
  const tags = () =>
    sqlite.query("SELECT item_id, tag_id FROM item_tags ORDER BY tag_id").all();
  await indexMail(DB, first);
  await indexMail(DB, reply);
  const [initial] = items();
  expect(initial).toMatchObject({
    title: "First subject",
    created: 10,
    updated: 30,
  });
  expect(items()).toHaveLength(1);
  await indexMail(DB, reply);
  expect(items()).toEqual([initial]);

  await indexMail(DB, second);
  const other = items()[1]!;
  sqlite.exec(
    "INSERT INTO tags VALUES ('owner', 'a', 'A', 'a'), ('owner', 'b', 'B', 'b')",
  );
  const tag = sqlite.query("INSERT INTO item_tags VALUES ('owner', ?, ?)");
  tag.run(initial!.id, "a");
  tag.run(other.id, "a");
  tag.run(other.id, "b");
  await indexMail(DB, bridge);
  const [merged] = items();
  expect(merged).toMatchObject({
    id: initial!.id,
    title: "First subject",
    created: 10,
    updated: 40,
  });
  expect(items()).toHaveLength(1);
  expect(merged!.revision).not.toBe(initial!.revision);
  expect(tags()).toEqual([
    { item_id: merged!.id, tag_id: "a" },
    { item_id: merged!.id, tag_id: "b" },
  ]);
  expect(
    (await readThread(DB, second.id)).messages.map(({ id }) => id),
  ).toEqual([first.id, second.id, reply.id, bridge.id]);

  for (const mail of [first, second, reply, bridge])
    await trashMail(DB, mail.id);
  expect(items()).toEqual([merged]);
  expect(await restoreMail(DB, bridge.id)).toBe(true);
  expect(items()).toEqual([merged]);
  await removeIndexedMail(DB, [{ folder: "inbox", id: first.id }]);
  expect(items()[0]).toMatchObject({
    id: merged!.id,
    title: "Other subject",
    created: 20,
    updated: 40,
  });
  for (const mail of [second, reply, bridge])
    await removeIndexedMail(DB, [{ folder: "inbox", id: mail.id }]);
  await indexMail(DB, bridge);
  expect(items()).toEqual([]);
  expect(sqlite.query("SELECT id FROM items").all()).toEqual([]);
  expect(tags()).toEqual([]);
  expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
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
  await removeIndexedMail(store.DB, [{ folder: "inbox", id: left.id }]);
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

it("isolates identical imported messages, conversations, preferences and completion by mailbox", async () => {
  using sqlite = new Database(":memory:");
  const personal = await setup(sqlite);
  sqlite.exec(
    "INSERT INTO mailboxes (id, owner_account_id, name) VALUES ('work', 'owner', 'Work')",
  );
  const work = scopeMailStore(personal, "work");
  const input = { ...metadata, archived: false, flags: [] };
  const first = await ingestRawMail(personal, input, raw());
  const second = await ingestRawMail(work, input, raw());
  expect(first.id).toBe(second.id);
  expect(second.status).toBe("imported");
  expect((await ingestRawMail(work, input, raw())).status).toBe("skipped");
  expect(personal.inbox.objects.size).toBe(2);
  expect(await work.INBOX_MESSAGES.head(first.id)).not.toBeNull();
  expect(
    (await work.INBOX_MESSAGES.list()).objects.map((object) => object.key),
  ).toEqual([first.id]);
  expect(
    (
      await mailboxBucket(personal.INBOX_MESSAGES, "personal").list()
    ).objects.map((object) => object.key),
  ).toEqual([first.id]);
  await expect(work.INBOX_MESSAGES.get(`../${first.id}`)).rejects.toThrow(
    "Invalid mail object key",
  );

  const later = await ingestRawMail(
    work,
    {
      ...input,
      source: { ...input.source, uid: 8 },
      timestamp: input.timestamp + 1000,
    },
    raw("reply", "root"),
  );
  expect((await readThread(personal.DB, first.id)).messages).toHaveLength(1);
  expect((await readThread(work.DB, first.id)).messages).toHaveLength(2);
  expect((await readThread(personal.DB, later.id)).messages).toHaveLength(0);
  expect(
    (await listConversations(personal.DB, { timestamp: null, id: "" }, "all"))
      .messages,
  ).toHaveLength(1);
  expect(
    (await listConversations(work.DB, { timestamp: null, id: "" }, "all"))
      .messages[0]?.messageCount,
  ).toBe(2);

  await setInboxUnread(personal.DB, first.id, false);
  expect((await inboxUnread(personal.DB)).unreadCount).toBe(0);
  expect((await inboxUnread(work.DB)).unreadCount).toBe(2);
  await writeProfile(
    personal.DB,
    crypto.randomUUID(),
    undefined,
    "Alice",
    ["alice@example.com"],
    null,
  );
  await setSenderRule(personal.DB, {
    address: "alice@example.com",
    priority: "noise",
  });
  expect(
    (await listConversations(personal.DB, { timestamp: null, id: "" }, "noise"))
      .messages,
  ).toHaveLength(1);
  expect(
    (await listConversations(work.DB, { timestamp: null, id: "" }, "noise"))
      .messages,
  ).toHaveLength(0);
  await setSenderAppearance(personal.DB, {
    address: "alice@example.com",
    mode: "service",
  });
  expect(
    (await senderAppearanceRules(personal.DB, ["alice@example.com"])).get(
      "alice@example.com",
    ),
  ).toBe("service");
  expect(
    (await senderAppearanceRules(work.DB, ["alice@example.com"])).size,
  ).toBe(0);

  const sourceId = (await personal.DB.prepare(
    "SELECT source_id AS id FROM mail_imports WHERE mailbox_id = 'personal'",
  ).first<{ id: string }>())!.id;
  const request = {
    id: "same-run",
    asOf: "2026-11-23T00:00:00Z",
    sourceIds: [sourceId],
  };
  expect(
    (await completeImportedConversations(personal.DB, request))
      .completedConversations,
  ).toBe(1);
  expect((await readThread(work.DB, first.id)).archived).toBe(false);
  expect(
    (await completeImportedConversations(work.DB, request))
      .completedConversations,
  ).toBe(0);
  expect(
    sqlite.query("SELECT count(*) AS n FROM mail_import_completions").get(),
  ).toEqual({ n: 2 });

  const deletedAt = Date.now();
  await trashMail(personal.DB, first.id, deletedAt);
  expect((await listTrash(work.DB)).messages).toHaveLength(0);
  expect((await listTrash(personal.DB)).messages).toHaveLength(1);
  expect(await restoreMail(work.DB, first.id)).toBe(false);
  await collectMailTrash(personal, deletedAt + mailRetentionMs + 1);
  expect(await personal.INBOX_MESSAGES.head(first.id)).toBeNull();
  expect(await work.INBOX_MESSAGES.head(first.id)).not.toBeNull();
  expect((await readThread(work.DB, first.id)).messages).toHaveLength(2);
});

it("empties all trash pages, purges message content, and resumes interrupted cleanup", async () => {
  using sqlite = new Database(":memory:");
  const store = await setup(sqlite);
  sqlite.exec("PRAGMA foreign_keys = ON");
  const active = await ingestRawMail(store, metadata, raw("active"));
  const trashed = [];
  for (let i = 0; i < 101; i++) {
    const folder = i === 100 ? "sent" : "inbox";
    const { id } = await ingestRawMail(
      store,
      {
        ...metadata,
        folder,
        source: { ...metadata.source, uid: metadata.source.uid + i + 1 },
      },
      raw(`trashed-${i}`, i === 0 ? "active" : ""),
    );
    await trashMail(store.DB, id);
    trashed.push({ id, folder });
  }
  expect((await listTrash(store.DB)).cursor).not.toBeNull();
  const sent = trashed.at(-1)!;
  expect(
    await attachmentResponse(store.SENT_MESSAGES, sent.id, 0, false),
  ).toBeInstanceOf(Response);

  store.failNextBatch();
  await expect(emptyMailTrash(store)).rejects.toThrow("D1 failure");
  expect(await restoreMail(store.DB, sent.id)).toBe(false);
  await emptyMailTrash(store);
  await emptyMailTrash(store);

  expect((await listTrash(store.DB)).messages).toEqual([]);
  expect(await store.SENT_MESSAGES.head(sent.id)).toBeNull();
  expect(
    await attachmentResponse(store.SENT_MESSAGES, sent.id, 0, false),
  ).toBeNull();
  expect([...store.inbox.objects.keys()]).toEqual([active.id]);
  expect(
    (await readThread(store.DB, active.id)).messages.map(({ id }) => id),
  ).toEqual([active.id]);
  expect(sqlite.query("SELECT message_id FROM mail_body_text").all()).toEqual([
    { message_id: active.id },
  ]);
  expect(
    sqlite.query("SELECT DISTINCT message_id FROM mail_body_terms").all(),
  ).toEqual([{ message_id: active.id }]);
  expect(
    sqlite.query("SELECT thread_id FROM mail_conversations").all(),
  ).toEqual([{ thread_id: active.id }]);
  expect(
    sqlite
      .query(
        "SELECT count(*) AS n FROM mail_index_messages WHERE deleted <> 0 AND (subject <> '' OR deleted_at IS NOT NULL OR trash_batch IS NOT NULL)",
      )
      .get(),
  ).toEqual({ n: 0 });
});

it("scopes index rebuilds and scan checkpoints to each mailbox storage namespace", async () => {
  using sqlite = new Database(":memory:");
  const personal = await setup(sqlite);
  sqlite.exec(
    "INSERT INTO mailboxes (id, owner_account_id, name) VALUES ('work', 'owner', 'Work')",
  );
  const work = scopeMailStore(personal, "work");
  const { id } = await ingestRawMail(work, metadata, raw());
  const scan = (store: typeof work) =>
    scanMail(
      store.DB,
      "inbox",
      store.INBOX_MESSAGES,
      (object) => describeStoredRawMail(store.INBOX_MESSAGES, object, "inbox"),
      true,
    );
  sqlite.exec("DELETE FROM mail_index_messages; DELETE FROM mail_index_keys;");
  await scan(scopeMailStore(personal, "personal"));
  expect((await readThread(personal.DB, id)).messages).toHaveLength(0);
  await scan(work);
  expect((await readThread(work.DB, id)).messages).toHaveLength(1);
  expect(
    sqlite
      .query("SELECT mailbox_id FROM mail_index_scans ORDER BY mailbox_id")
      .all(),
  ).toEqual([{ mailbox_id: "personal" }, { mailbox_id: "work" }]);
});

it("keeps mailbox identities independent of login and resolves only enabled exact routes", async () => {
  using sqlite = new Database(":memory:");
  const store = await setup(sqlite);
  await ensureDefaultMailbox(
    store.DB,
    "mail@app.example",
    "mail@app.example",
    "mail@dpeek.com,david@winterpeek.com",
  );
  expect(
    (await mailboxIdentities(store.DB)).map((identity) => identity.address),
  ).toEqual(["david@winterpeek.com", "mail@app.example", "mail@dpeek.com"]);
  expect(
    (await mailboxIdentities(store.DB)).find(
      (identity) => identity.address === "mail@dpeek.com",
    )?.canSend,
  ).toBe(0);
  sqlite.exec(
    "INSERT INTO accounts (id, active, security_revision) VALUES ('family', 1, '1'); INSERT INTO mailboxes (id, owner_account_id, name) VALUES ('family', 'family', 'Personal'); INSERT INTO mail_inbound_routes VALUES ('family@winterpeek.com', 'family', 1);",
  );
  expect(await resolveMailRecipient(store.DB, "DAVID@WINTERPEEK.COM")).toBe(
    "personal",
  );
  expect(await resolveMailRecipient(store.DB, "family@winterpeek.com")).toBe(
    "family",
  );
  expect(
    await resolveMailRecipient(store.DB, "unassigned@winterpeek.com"),
  ).toBeNull();
  expect(await resolveMailRecipient(store.DB, "mail@unrelated.com")).toBeNull();
  sqlite.exec(
    "UPDATE mail_inbound_routes SET enabled = 0 WHERE address = 'family@winterpeek.com'",
  );
  expect(
    await resolveMailRecipient(store.DB, "family@winterpeek.com"),
  ).toBeNull();
  await expect(requireMailbox(store.DB, "family", "owner")).rejects.toThrow(
    "unavailable",
  );
  await expect(requireMailbox(store.DB, "personal", "family")).rejects.toThrow(
    "unavailable",
  );
  expect((await requireMailbox(store.DB, "personal", "owner")).id).toBe(
    "personal",
  );
  await ensureDefaultMailbox(store.DB, "mail@app.example", "mail@app.example");
  expect(await mailboxIdentities(store.DB)).toHaveLength(3);
});

it("migrates existing inbound and disabled addresses and retires the legacy mailbox identity", async () => {
  using sqlite = new Database(":memory:");
  const root = new URL("../../drizzle/", import.meta.url).pathname;
  const migrations = [...new Bun.Glob("*/migration.sql").scanSync(root)].sort();
  const inbound = migrations.find((file) =>
    file.includes("_inbound_mail_routes/"),
  )!;
  for (const file of migrations.slice(0, migrations.indexOf(inbound)))
    sqlite.exec(await Bun.file(root + file).text());
  sqlite.exec(`
    INSERT INTO accounts (id, active, security_revision) VALUES ('owner', 1, '1');
    INSERT INTO mailboxes (id, owner_account_id, name) VALUES ('personal', 'owner', 'Personal');
    INSERT INTO mailbox_addresses (address, mailbox_id, can_receive, can_send) VALUES
      ('mail@dpeek.com', 'personal', 1, 1),
      ('quiet@dpeek.com', 'personal', 0, 0),
      ('mail@app.dpeek.com', 'personal', 1, 0);
    INSERT INTO mail_domain_routes VALUES ('dpeek.com', 'personal');
    INSERT INTO people (id, account_id, name, revision) VALUES ('profile', 'owner', '', '1');
    INSERT INTO person_addresses VALUES ('mail@app.dpeek.com', 'profile');
  `);
  sqlite.exec(await Bun.file(root + inbound).text());
  expect(
    sqlite.query("SELECT * FROM mail_inbound_routes ORDER BY address").all(),
  ).toEqual([
    { address: "mail@dpeek.com", mailbox_id: "personal", enabled: 1 },
    { address: "quiet@dpeek.com", mailbox_id: "personal", enabled: 0 },
  ]);
  expect(
    sqlite
      .query("SELECT address FROM mailbox_addresses WHERE can_send = 1")
      .all(),
  ).toEqual([{ address: "mail@dpeek.com" }]);
  expect(
    sqlite
      .query(
        "SELECT address FROM mailbox_addresses WHERE address = 'mail@app.dpeek.com'",
      )
      .get(),
  ).toBeNull();
  expect(sqlite.query("SELECT * FROM mail_domain_routes").all()).toEqual([]);
  expect(sqlite.query("SELECT * FROM person_addresses").all()).toEqual([]);
});
