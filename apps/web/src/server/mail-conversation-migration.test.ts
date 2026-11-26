import { expect, it } from "@effect/vitest";
import { Database } from "bun:sqlite";
import { Schema } from "effect";
import { ItemId } from "../items-contract.ts";

it("backfills one owned item per retained conversation without rewriting mail", async () => {
  using db = new Database(":memory:");
  const root = new URL("../../drizzle/", import.meta.url).pathname;
  const migrations = Array.from(
    new Bun.Glob("*/migration.sql").scanSync(root),
  ).sort();
  const upgrade = migrations.find((file) =>
    file.includes("_mail_conversation_items/"),
  )!;
  for (const file of migrations.filter((file) => file < upgrade))
    db.exec(await Bun.file(root + file).text());

  db.exec(`
    PRAGMA foreign_keys = ON;
    INSERT INTO accounts (id, active, security_revision) VALUES ('owner', 1, '1'), ('other', 1, '1');
    INSERT INTO mailboxes (id, owner_account_id, name) VALUES ('personal', 'owner', 'Personal'), ('other', 'other', 'Other');
    INSERT INTO items (account_id, id, kind, title, revision, created_at, updated_at)
    VALUES ('owner', 'task', 'task', 'Existing item', 'existing-revision', 1, 1);
    INSERT INTO mail_index_messages (mailbox_id, id, thread_id, folder, sender, recipient, subject, timestamp, deleted, deleted_at)
    VALUES ('personal', 'one', 'thread', 'inbox', 'sender@example.com', 'recipient@example.com', ' First subject ', 20, 0, NULL),
           ('personal', 'two', 'thread', 'sent', 'recipient@example.com', 'sender@example.com', 'Re: First subject', 30, 0, NULL),
           ('other', 'one', 'thread', 'inbox', '', '', 'Other mailbox', 25, 0, NULL),
           ('personal', 'trash', 'trash', 'inbox', '', '', '', 40, 1, 50),
           ('personal', 'purged', 'purged', 'inbox', '', '', '', 0, 1, NULL);
    INSERT INTO mail_index_keys (mailbox_id, identity, thread_id)
    VALUES ('personal', 'mail:one', 'thread'), ('other', 'mail:one', 'thread');
  `);
  const messages = () =>
    db.query("SELECT * FROM mail_index_messages ORDER BY mailbox_id, id").all();
  const aliases = () =>
    db
      .query("SELECT * FROM mail_index_keys ORDER BY mailbox_id, identity")
      .all();
  const before = [messages(), aliases()];
  const sql = await Bun.file(root + upgrade).text();
  db.transaction(() => db.exec(sql))();

  const rows = db
    .query<
      {
        mailbox: string;
        account: string;
        thread: string;
        id: string;
        kind: string;
        title: string;
        created: number;
        updated: number;
      },
      []
    >(
      `
    SELECT c.mailbox_id AS mailbox, c.account_id AS account, c.thread_id AS thread,
      i.id, i.kind, i.title, i.created_at AS created, i.updated_at AS updated
    FROM mail_conversations c JOIN items i ON i.account_id = c.account_id AND i.id = c.item_id
    ORDER BY c.mailbox_id, c.thread_id
  `,
    )
    .all();
  expect(
    rows.map(({ id, ...row }) => {
      expect(Schema.is(ItemId)(id)).toBe(true);
      return row;
    }),
  ).toEqual([
    {
      mailbox: "other",
      account: "other",
      thread: "thread",
      kind: "mail-conversation",
      title: "Other mailbox",
      created: 25,
      updated: 25,
    },
    {
      mailbox: "personal",
      account: "owner",
      thread: "thread",
      kind: "mail-conversation",
      title: "First subject",
      created: 20,
      updated: 30,
    },
    {
      mailbox: "personal",
      account: "owner",
      thread: "trash",
      kind: "mail-conversation",
      title: "(No subject)",
      created: 40,
      updated: 40,
    },
  ]);
  expect(new Set(rows.map(({ id }) => id)).size).toBe(3);
  expect([messages(), aliases()]).toEqual(before);
  expect(
    db.query("SELECT kind, title, revision FROM items WHERE id = 'task'").get(),
  ).toEqual({
    kind: "task",
    title: "Existing item",
    revision: "existing-revision",
  });
  expect(() =>
    db.exec(`
    INSERT INTO mail_conversations (mailbox_id, thread_id, account_id, item_id)
    VALUES ('other', 'wrong-owner', 'owner', 'task');
  `),
  ).toThrow(/FOREIGN KEY/u);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
