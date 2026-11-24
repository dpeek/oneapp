import { Schema } from "effect";
import { ItemId, ItemTagIds, itemTagLimit, Tag } from "./items-contract.ts";

export const tasksPath = "/tasks";
const completedTasksPath = `${tasksPath}/completed`;
export const tasksApi = "/api/tasks";
export const TaskView = Schema.Literals(["active", "completed"]);
export type TaskView = typeof TaskView.Type;
export const taskListPath = (view: TaskView) =>
  view === "completed" ? completedTasksPath : tasksPath;
export const taskPath = (id: string, view: TaskView = "active") =>
  `${taskListPath(view)}/${id}`;
export const taskApi = (id: string) => `${tasksApi}/${id}`;

export const TaskRoute = Schema.Struct({
  view: TaskView,
  id: Schema.NullOr(ItemId),
});
export const taskRouteFor = (
  pathname: string,
): typeof TaskRoute.Type | null => {
  const path = pathname.replace(/\/$/u, "");
  const view =
    path === completedTasksPath || path.startsWith(`${completedTasksPath}/`)
      ? "completed"
      : "active";
  const list = taskListPath(view);
  if (path === list) return { view, id: null };
  if (!path.startsWith(`${list}/`)) return null;
  const id = path.slice(list.length + 1);
  return Schema.is(ItemId)(id) ? { view, id } : null;
};

export const activeTaskStatuses = [
  "not-started",
  "in-progress",
  "in-review",
] as const;
export const TaskStatus = Schema.NullOr(
  Schema.Literals([...activeTaskStatuses, "completed", "canceled"]),
);
export const TaskPriority = Schema.NullOr(
  Schema.Literals(["low", "medium", "high", "urgent"]),
);

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
  status: Schema.optional(TaskStatus),
  priority: Schema.optional(TaskPriority),
  dueOn: Schema.optional(TaskFields.fields.dueOn),
  tagIds: Schema.optional(TaskFields.fields.tagIds),
});
export const TaskUpdate = Schema.Struct({
  ...TaskFields.fields,
  revision: ItemId,
});
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
