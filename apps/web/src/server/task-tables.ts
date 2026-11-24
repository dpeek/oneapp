import {
  foreignKey,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { Task } from "../tasks-contract.ts";
import { items } from "./item-tables.ts";

export const tasks = sqliteTable(
  "tasks",
  {
    accountId: text("account_id").notNull(),
    itemId: text("item_id").notNull(),
    description: text().notNull().default(""),
    status: text().$type<Task["status"]>().default("not-started"),
    priority: text().$type<Task["priority"]>(),
    dueOn: text("due_on"),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.itemId] }),
    foreignKey({
      columns: [table.accountId, table.itemId],
      foreignColumns: [items.accountId, items.id],
    }).onDelete("cascade"),
  ],
);
