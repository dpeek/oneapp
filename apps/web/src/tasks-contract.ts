import { Schema } from "effect";
import { ItemId, Tag } from "./items-contract.ts";

export const tasksPath = "/tasks";
export const tasksApi = "/api/tasks";
export const taskPath = (id: string) => `${tasksPath}/${id}`;
export const taskApi = (id: string) => `${tasksApi}/${id}`;

export const TaskRoute = Schema.Struct({ id: Schema.NullOr(ItemId) });
export const taskRouteFor = (
  pathname: string,
): typeof TaskRoute.Type | null => {
  if (pathname === tasksPath || pathname === `${tasksPath}/`)
    return { id: null };
  const id = /^\/tasks\/([^/]+)\/?$/u.exec(pathname)?.[1];
  return Schema.is(ItemId)(id) ? { id } : null;
};

export const TaskStatus = Schema.NullOr(
  Schema.Literals([
    "not-started",
    "in-progress",
    "in-review",
    "completed",
    "canceled",
  ]),
);
export const TaskPriority = Schema.NullOr(
  Schema.Literals(["low", "medium", "high", "urgent"]),
);

export const taskTitleLimit = 200;
export const taskDescriptionLimit = 20_000;
export const taskTagLimit = 32;

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
  tagIds: Schema.Array(ItemId).check(Schema.isMaxLength(taskTagLimit)),
});
export const TaskCreate = Schema.Struct({ id: ItemId, title: TaskTitle });
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
