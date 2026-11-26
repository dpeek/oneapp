import { Schema } from "effect";
import { ItemId } from "./items-contract.ts";
import {
  activeTaskStatuses,
  TaskPriority,
  type Task,
  TaskStatus,
} from "./tasks-contract.ts";

export const Filters = Schema.Struct({
  statuses: Schema.Array(TaskStatus),
  priorities: Schema.Array(TaskPriority),
  tagIds: Schema.Array(ItemId),
});
export const emptyFilters: typeof Filters.Type = {
  statuses: [],
  priorities: [],
  tagIds: [],
};
export const defaultFilters: typeof Filters.Type = {
  ...emptyFilters,
  statuses: activeTaskStatuses,
};

export const toggleFilter = <Value>(values: readonly Value[], value: Value) =>
  values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];

export const taskFilterCount = ({
  statuses,
  priorities,
  tagIds,
}: typeof Filters.Type) => statuses.length + priorities.length + tagIds.length;

export const matchesTaskFilters = (task: Task, filters: typeof Filters.Type) =>
  (!filters.statuses.length || filters.statuses.includes(task.status)) &&
  (!filters.priorities.length || filters.priorities.includes(task.priority)) &&
  (!filters.tagIds.length ||
    task.tagIds.some((id) => filters.tagIds.includes(id)));
