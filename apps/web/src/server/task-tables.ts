import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { Task } from "../tasks-contract.ts";
import type { TaskAttachment } from "../task-attachment-contract.ts";
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

export const taskAttachments = sqliteTable(
  "task_attachments",
  {
    accountId: text("account_id").notNull(),
    taskId: text("task_id").notNull(),
    id: text().notNull(),
    name: text().notNull(),
    mediaType: text("media_type")
      .$type<TaskAttachment["mediaType"]>()
      .notNull(),
    size: integer().notNull(),
    createdAt: integer("created_at").notNull(),
    state: text({ enum: ["pending", "ready", "removed"] }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.taskId, table.id] }),
    foreignKey({
      columns: [table.accountId, table.taskId],
      foreignColumns: [tasks.accountId, tasks.itemId],
    }).onDelete("cascade"),
    index("task_attachments_cleanup").on(table.state, table.createdAt),
  ],
);
