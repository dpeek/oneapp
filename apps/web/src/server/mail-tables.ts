import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { mailboxes } from "./mailbox-tables.ts";
import { items } from "./item-tables.ts";
import { sql } from "drizzle-orm";

export const mailChanges = sqliteTable("mail_changes", {
  mailboxId: text("mailbox_id")
    .primaryKey()
    .references(() => mailboxes.id, { onDelete: "cascade" }),
  version: integer().notNull(),
});

export const mailConversations = sqliteTable(
  "mail_conversations",
  {
    mailboxId: text("mailbox_id").notNull(),
    threadId: text("thread_id").notNull(),
    accountId: text("account_id").notNull(),
    itemId: text("item_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.mailboxId, table.threadId] }),
    uniqueIndex("mail_conversations_item").on(table.accountId, table.itemId),
    foreignKey({
      columns: [table.accountId, table.itemId],
      foreignColumns: [items.accountId, items.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.mailboxId, table.accountId],
      foreignColumns: [mailboxes.id, mailboxes.ownerAccountId],
    }),
  ],
);

export const mailIndexMessages = sqliteTable(
  "mail_index_messages",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .default("personal")
      .references(() => mailboxes.id),
    id: text().notNull(),
    envelopeRecipient: text("envelope_recipient"),
    threadId: text("thread_id").notNull(),
    folder: text().notNull(),
    sender: text().notNull(),
    recipient: text().notNull(),
    subject: text().notNull(),
    timestamp: integer().notNull(),
    deleted: integer().notNull().default(0),
    deletedAt: integer("deleted_at"),
    trashBatch: text("trash_batch"),
    unread: integer().notNull().default(0),
    archived: integer().notNull().default(0),
    people: text(),
    listMail: integer("list_mail"),
    bodyPreview: text("body_preview"),
  },
  (table) => [
    primaryKey({ columns: [table.mailboxId, table.id] }),
    index("mail_index_deleted_date").on(
      table.mailboxId,
      table.deleted,
      table.deletedAt,
    ),
    index("mail_index_trash_batch")
      .on(table.mailboxId, table.trashBatch)
      .where(sql`trash_batch IS NOT NULL`),
    index("mail_index_folder_date").on(
      table.mailboxId,
      table.folder,
      table.deleted,
      table.timestamp,
      table.id,
    ),
    index("mail_index_thread_folder_date").on(
      table.mailboxId,
      table.threadId,
      table.folder,
      table.deleted,
      table.timestamp,
      table.id,
    ),
    index("mail_index_unread")
      .on(table.mailboxId, table.threadId)
      .where(sql`folder = 'inbox' AND deleted = 0 AND unread = 1`),
    index("mail_index_inbox_archive_date")
      .on(table.mailboxId, table.archived, table.timestamp, table.id)
      .where(sql`folder = 'inbox' AND deleted = 0`),
    index("mail_index_all_date")
      .on(table.mailboxId, table.timestamp, table.id)
      .where(sql`deleted = 0`),
    index("mail_index_all_thread_date")
      .on(table.mailboxId, table.threadId, table.timestamp, table.id)
      .where(sql`deleted = 0`),
  ],
);

export const mailIndexKeys = sqliteTable(
  "mail_index_keys",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .default("personal")
      .references(() => mailboxes.id),
    identity: text().notNull(),
    threadId: text("thread_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.mailboxId, table.identity] }),
    index("mail_index_keys_thread").on(table.mailboxId, table.threadId),
  ],
);

export const mailIndexScans = sqliteTable(
  "mail_index_scans",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .default("personal")
      .references(() => mailboxes.id),
    folder: text().notNull(),
    cursor: text(),
    scannedAt: integer("scanned_at").notNull(),
    ready: integer().notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.mailboxId, table.folder] })],
);

export const mailSenderRules = sqliteTable(
  "mail_sender_rules",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .default("personal")
      .references(() => mailboxes.id),
    address: text().notNull(),
    priority: text({ enum: ["signal", "noise"] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.mailboxId, table.address] })],
);

export const mailSenderAvatars = sqliteTable(
  "mail_sender_avatars",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .default("personal")
      .references(() => mailboxes.id),
    address: text().notNull(),
    kind: text({ enum: ["person", "service"] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.mailboxId, table.address] })],
);
