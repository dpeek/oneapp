import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { StoredFile } from "../files-contract.ts";
import { accounts } from "./database.ts";
import { items } from "./item-tables.ts";

export const fileChanges = sqliteTable("file_changes", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  version: integer().notNull(),
});

export const files = sqliteTable(
  "files",
  {
    accountId: text("account_id").notNull(),
    itemId: text("item_id").notNull(),
    mediaType: text("media_type").notNull(),
    size: integer().notNull(),
    previewType: text("preview_type").$type<StoredFile["previewType"]>(),
    documentKey: text("document_key"),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.itemId] }),
    foreignKey({
      columns: [table.accountId, table.itemId],
      foreignColumns: [items.accountId, items.id],
    }).onDelete("cascade"),
  ],
);

// Keep object reservations and cleanup records after the owning item is deleted.
export const fileObjects = sqliteTable(
  "file_objects",
  {
    key: text().primaryKey(),
    accountId: text("account_id").notNull(),
    itemId: text("item_id").notNull(),
    kind: text().$type<"body" | "image" | "upload">().notNull(),
    state: text().$type<"pending" | "staged" | "live" | "removed">().notNull(),
    expiresAt: integer("expires_at"),
  },
  (table) => [
    index("file_objects_owner").on(table.accountId, table.itemId),
    index("file_objects_expiration").on(table.expiresAt),
  ],
);
