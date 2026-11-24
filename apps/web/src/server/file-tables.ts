import {
  foreignKey,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { StoredFile } from "../files-contract.ts";
import { items } from "./item-tables.ts";

export const files = sqliteTable(
  "files",
  {
    accountId: text("account_id").notNull(),
    itemId: text("item_id").notNull(),
    mediaType: text("media_type").notNull(),
    size: integer().notNull(),
    previewType: text("preview_type").$type<StoredFile["previewType"]>(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.itemId] }),
    foreignKey({
      columns: [table.accountId, table.itemId],
      foreignColumns: [items.accountId, items.id],
    }).onDelete("cascade"),
  ],
);
