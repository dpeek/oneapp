import { Schema } from "effect";
import { ItemId } from "./items-contract.ts";
import {
  activeTaskStatuses,
  TaskPriority,
  type Task,
  TaskAssignee,
  type TaskList,
  TaskStatus,
} from "./tasks-contract.ts";

export const Filters = Schema.Struct({
  statuses: Schema.Array(TaskStatus),
  priorities: Schema.Array(TaskPriority),
  assignees: Schema.Array(TaskAssignee),
  tagIds: Schema.Array(ItemId),
});
export const emptyFilters: typeof Filters.Type = {
  statuses: [],
  priorities: [],
  assignees: [],
  tagIds: [],
};
export const taskListFilters: Record<TaskList, typeof Filters.Type> = {
  active: { ...emptyFilters, statuses: activeTaskStatuses },
  complete: { ...emptyFilters, statuses: ["completed"] },
  all: emptyFilters,
};

export const toggleFilter = <Value>(values: readonly Value[], value: Value) =>
  values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];

export const taskFilterCount = ({
  statuses,
  priorities,
  assignees,
  tagIds,
}: typeof Filters.Type) =>
  statuses.length + priorities.length + assignees.length + tagIds.length;

export const matchesTaskFilters = (task: Task, filters: typeof Filters.Type) =>
  (!filters.statuses.length || filters.statuses.includes(task.status)) &&
  (!filters.priorities.length || filters.priorities.includes(task.priority)) &&
  (!filters.assignees.length || filters.assignees.includes(task.assignee)) &&
  (!filters.tagIds.length ||
    task.tagIds.some((id) => filters.tagIds.includes(id)));
