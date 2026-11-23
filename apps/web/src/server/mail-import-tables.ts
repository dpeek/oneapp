import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const mailImports = sqliteTable(
  "mail_imports",
  {
    sourceId: text("source_id").primaryKey(),
    messageId: text("message_id").notNull(),
    sha256: text().notNull(),
    metadata: text().notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [uniqueIndex("mail_imports_message").on(table.messageId)],
);

export const mailImportCompletions = sqliteTable("mail_import_completions", {
  id: text().primaryKey(),
  policy: text().notNull(),
  decisions: text().notNull(),
  completedAt: integer("completed_at"),
});
