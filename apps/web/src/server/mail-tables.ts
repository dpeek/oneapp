import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
