import { inArray } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import {
  defaultTaskStatus,
  taskStatuses,
  workspaceActorKinds,
  type Task,
} from "../tasks-contract.ts";
import type { TaskAttachment } from "../task-attachment-contract.ts";
import { taskRunPhases, type TaskRun } from "../task-run-contract.ts";
import { items } from "./item-tables.ts";
import { accounts } from "./database.ts";

export const taskChanges = sqliteTable("task_changes", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  version: integer().notNull(),
});

export const tasks = sqliteTable(
  "tasks",
  {
    accountId: text("account_id").notNull(),
    itemId: text("item_id").notNull(),
    description: text().notNull().default(""),
    status: text({ enum: taskStatuses }).notNull().default(defaultTaskStatus),
    priority: text().$type<Task["priority"]>(),
    dueOn: text("due_on"),
    author: text({ enum: workspaceActorKinds }),
    assignee: text({ enum: workspaceActorKinds }),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.itemId] }),
    check("tasks_status", inArray(table.status, taskStatuses).inlineParams()),
    foreignKey({
      columns: [table.accountId, table.itemId],
      foreignColumns: [items.accountId, items.id],
    }).onDelete("cascade"),
  ],
);

export const taskRuns = sqliteTable(
  "task_runs",
  {
    accountId: text("account_id").notNull(),
    taskId: text("task_id").notNull(),
    id: text().notNull(),
    claimRevision: text("claim_revision").notNull(),
    assignmentRequestRevision: text("assignment_request_revision"),
    phase: text({ enum: taskRunPhases }).notNull(),
    startedAt: integer("started_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    expiresAt: integer("expires_at"),
    finishedAt: integer("finished_at"),
    outcome: text().$type<TaskRun["outcome"]>(),
    summary: text(),
    reason: text(),
    deploymentUrl: text("deployment_url"),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.taskId] }),
    foreignKey({
      columns: [table.accountId, table.taskId],
      foreignColumns: [tasks.accountId, tasks.itemId],
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
    state: text({ enum: ["pending", "staged", "ready", "removed"] }).notNull(),
    inlineDeleteAfter: integer("inline_delete_after"),
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

export const deletedTaskAttachments = sqliteTable(
  "deleted_task_attachments",
  {
    accountId: text("account_id").notNull(),
    taskId: text("task_id").notNull(),
    id: text().notNull(),
    deleteAfter: integer("delete_after").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.taskId, table.id] }),
    index("deleted_task_attachments_due").on(table.deleteAfter),
  ],
);
