import { Schema } from "effect";
import { ItemId } from "./items-contract.ts";
import {
  activeTaskStatuses,
  TaskPriority,
  type Task,
  type TaskView,
} from "./tasks-contract.ts";

export const StatusFilter = Schema.NullOr(Schema.Literals(activeTaskStatuses));
export const Filters = Schema.Struct({
  statuses: Schema.Array(StatusFilter),
  priorities: Schema.Array(TaskPriority),
  tagIds: Schema.Array(ItemId),
});
export const emptyFilters: typeof Filters.Type = {
  statuses: [],
  priorities: [],
  tagIds: [],
};

export const toggleFilter = <Value>(values: readonly Value[], value: Value) =>
  values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];

type FilterState = { filters: typeof Filters.Type; view: TaskView };

export const taskFilterCount = ({ filters, view }: FilterState) =>
  (view === "active" ? filters.statuses.length : 0) +
  filters.priorities.length +
  filters.tagIds.length;

export const matchesTaskFilters = (
  task: Task,
  { filters, view }: FilterState,
) =>
  (view === "completed" ||
    !filters.statuses.length ||
    filters.statuses.some((status) => status === task.status)) &&
  (!filters.priorities.length || filters.priorities.includes(task.priority)) &&
  (!filters.tagIds.length ||
    task.tagIds.some((id) => filters.tagIds.includes(id)));
