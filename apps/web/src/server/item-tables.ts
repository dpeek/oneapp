import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { accounts } from "./database.ts";

export const items = sqliteTable(
  "items",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    id: text().notNull(),
    kind: text().notNull(),
    title: text().notNull(),
    revision: text().notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.id] }),
    index("items_kind_updated").on(
      table.accountId,
      table.kind,
      table.updatedAt,
      table.id,
    ),
  ],
);

export const tags = sqliteTable(
  "tags",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    id: text().notNull(),
    name: text().notNull(),
    nameKey: text("name_key").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.id] }),
    uniqueIndex("tags_name").on(table.accountId, table.nameKey),
  ],
);

export const itemTags = sqliteTable(
  "item_tags",
  {
    accountId: text("account_id").notNull(),
    itemId: text("item_id").notNull(),
    tagId: text("tag_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.itemId, table.tagId] }),
    foreignKey({
      columns: [table.accountId, table.itemId],
      foreignColumns: [items.accountId, items.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.accountId, table.tagId],
      foreignColumns: [tags.accountId, tags.id],
    }).onDelete("cascade"),
    index("item_tags_by_tag").on(table.accountId, table.tagId, table.itemId),
  ],
);
