import { expect, it } from "@effect/vitest";
import type { Task } from "./tasks-contract.ts";
import {
  emptyFilters,
  matchesTaskFilters,
  taskFilterCount,
  toggleFilter,
} from "./tasks-filters.ts";

const alpha = "00000000-0000-4000-8000-000000000001";
const beta = "00000000-0000-4000-8000-000000000002";
const gamma = "00000000-0000-4000-8000-000000000003";
const task: Task = {
  id: alpha,
  revision: beta,
  title: "Task",
  description: "",
  status: "in-progress",
  priority: "high",
  dueOn: null,
  tagIds: [beta],
  createdAt: 0,
  updatedAt: 0,
};

it("matches any selected value within each task filter and requires every category to match", () => {
  const model = {
    view: "active" as const,
    filters: {
      statuses: [null, "in-progress"] as const,
      priorities: [null, "high"] as const,
      tagIds: [alpha, beta],
    },
  };
  expect(taskFilterCount(model)).toBe(6);
  expect(matchesTaskFilters(task, model)).toBe(true);
  expect(
    matchesTaskFilters(
      { ...task, status: null, priority: null, tagIds: [alpha] },
      model,
    ),
  ).toBe(true);
  expect(matchesTaskFilters({ ...task, status: "in-review" }, model)).toBe(
    false,
  );
  expect(matchesTaskFilters({ ...task, priority: "low" }, model)).toBe(false);
  expect(matchesTaskFilters({ ...task, tagIds: [gamma] }, model)).toBe(false);

  const completed = { ...model, view: "completed" as const };
  expect(taskFilterCount(completed)).toBe(4);
  expect(matchesTaskFilters({ ...task, status: "completed" }, completed)).toBe(
    true,
  );
});

it("toggles a missing status without removing other selections", () => {
  const selected = toggleFilter(["in-progress"], null);
  expect(selected).toEqual(["in-progress", null]);
  expect(toggleFilter(selected, null)).toEqual(["in-progress"]);
});

it("allows all tasks through when no values are selected", () => {
  const model = { view: "active" as const, filters: emptyFilters };
  expect(taskFilterCount(model)).toBe(0);
  expect(matchesTaskFilters(task, model)).toBe(true);
});
