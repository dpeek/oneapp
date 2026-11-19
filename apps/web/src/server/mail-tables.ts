import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const mailIndexMessages = sqliteTable(
  "mail_index_messages",
  {
    id: text().primaryKey(),
    threadId: text("thread_id").notNull(),
    folder: text().notNull(),
    sender: text().notNull(),
    recipient: text().notNull(),
    subject: text().notNull(),
    timestamp: integer().notNull(),
    deleted: integer().notNull().default(0),
    unread: integer().notNull().default(0),
    archived: integer().notNull().default(0),
    people: text(),
    listMail: integer("list_mail"),
  },
  (table) => [
    index("mail_index_folder_date").on(
      table.folder,
      table.deleted,
      table.timestamp,
      table.id,
    ),
    index("mail_index_thread_folder_date").on(
      table.threadId,
      table.folder,
      table.deleted,
      table.timestamp,
      table.id,
    ),
    index("mail_index_unread")
      .on(table.threadId)
      .where(sql`folder = 'inbox' AND deleted = 0 AND unread = 1`),
    index("mail_index_inbox_archive_date")
      .on(table.archived, table.timestamp, table.id)
      .where(sql`folder = 'inbox' AND deleted = 0`),
    index("mail_index_all_date")
      .on(table.timestamp, table.id)
      .where(sql`deleted = 0`),
    index("mail_index_all_thread_date")
      .on(table.threadId, table.timestamp, table.id)
      .where(sql`deleted = 0`),
  ],
);

export const mailIndexKeys = sqliteTable(
  "mail_index_keys",
  {
    identity: text().primaryKey(),
    threadId: text("thread_id").notNull(),
  },
  (table) => [index("mail_index_keys_thread").on(table.threadId)],
);

export const mailIndexScans = sqliteTable("mail_index_scans", {
  folder: text().primaryKey(),
  cursor: text(),
  scannedAt: integer("scanned_at").notNull(),
  ready: integer().notNull().default(0),
});

export const mailSenderRules = sqliteTable("mail_sender_rules", {
  address: text().primaryKey(),
  priority: text({ enum: ["signal", "noise"] }).notNull(),
});
