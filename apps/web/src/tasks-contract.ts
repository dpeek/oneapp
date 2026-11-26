import { Schema } from "effect";
import { ItemId, ItemTagIds, itemTagLimit, Tag } from "./items-contract.ts";

export const tasksPath = "/tasks";
export const tasksApi = "/api/tasks";
export const tasksChanged = "tasks.changed";
export const taskPath = (id: string) => `${tasksPath}/${id}`;
export const taskApi = (id: string) => `${tasksApi}/${id}` as const;

export const TaskRoute = Schema.Struct({
  id: Schema.NullOr(ItemId),
});
export const taskRouteFor = (
  pathname: string,
): typeof TaskRoute.Type | null => {
  const path = pathname.replace(/\/$/u, "");
  if (path === tasksPath) return { id: null };
  if (!path.startsWith(`${tasksPath}/`)) return null;
  const id = path.slice(tasksPath.length + 1);
  return Schema.is(ItemId)(id) ? { id } : null;
};

export const defaultTaskStatus = "not-started";
export const activeTaskStatuses = [
  defaultTaskStatus,
  "in-progress",
  "in-review",
] as const;
export const taskStatuses = [
  ...activeTaskStatuses,
  "completed",
  "canceled",
] as const;
export const TaskStatus = Schema.Literals(taskStatuses);
export const taskPriorities = ["low", "medium", "high", "urgent"] as const;
export const TaskPriority = Schema.NullOr(Schema.Literals(taskPriorities));

export const taskTitleLimit = 200;
export const taskDescriptionLimit = 20_000;
export const taskTagLimit = itemTagLimit;

export const TaskTitle = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(taskTitleLimit),
);
export const TaskDate = Schema.String.check(
  Schema.isPattern(/^(?!0000)\d{4}-\d{2}-\d{2}$/u),
  Schema.makeFilter((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }),
);
export const TaskFields = Schema.Struct({
  title: TaskTitle,
  description: Schema.String.check(Schema.isMaxLength(taskDescriptionLimit)),
  status: TaskStatus,
  priority: TaskPriority,
  dueOn: Schema.NullOr(TaskDate),
  tagIds: ItemTagIds,
});
export const TaskCreate = Schema.Struct({
  id: ItemId,
  title: TaskTitle,
  description: Schema.optional(TaskFields.fields.description),
  status: Schema.optionalKey(TaskStatus),
  priority: Schema.optional(TaskPriority),
  dueOn: Schema.optional(TaskFields.fields.dueOn),
  tagIds: Schema.optional(TaskFields.fields.tagIds),
});
export const TaskUpdate = Schema.Struct({
  ...TaskFields.fields,
  revision: ItemId,
});
export const TaskDelete = Schema.Struct({ revision: ItemId });
export const Task = Schema.Struct({
  ...TaskUpdate.fields,
  id: ItemId,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type Task = typeof Task.Type;
export const TaskIndex = Schema.Struct({
  tasks: Schema.Array(Task),
  tags: Schema.Array(Tag),
});
export const TaskSnapshot = Schema.Struct({
  ...TaskIndex.fields,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
