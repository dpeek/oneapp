import { mailboxes } from "./mailbox-tables.ts";
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const mailImports = sqliteTable(
  "mail_imports",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .default("personal")
      .references(() => mailboxes.id),
    sourceId: text("source_id").notNull(),
    messageId: text("message_id").notNull(),
    sha256: text().notNull(),
    metadata: text().notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.mailboxId, table.sourceId] }),
    uniqueIndex("mail_imports_message").on(table.mailboxId, table.messageId),
  ],
);

export const mailImportCompletions = sqliteTable(
  "mail_import_completions",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .default("personal")
      .references(() => mailboxes.id),
    id: text().notNull(),
    policy: text().notNull(),
    decisions: text().notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [primaryKey({ columns: [table.mailboxId, table.id] })],
);

export const mailImportRuns = sqliteTable(
  "mail_import_runs",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id),
    id: text().notNull(),
    configuration: text().notNull(),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [primaryKey({ columns: [table.mailboxId, table.id] })],
);
