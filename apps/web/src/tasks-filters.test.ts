import { expect, it } from "@effect/vitest";
import { type Task, taskStatuses } from "./tasks-contract.ts";
import {
  emptyFilters,
  matchesTaskFilters,
  taskFilterCount,
  taskListFilters,
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
  author: null,
  assignee: null,
  tagIds: [beta],
  createdAt: 0,
  updatedAt: 0,
  latestRun: null,
};

it("matches any selected value within each task filter and requires every category to match", () => {
  const filters = {
    statuses: ["not-started", "in-progress", "completed"] as const,
    priorities: [null, "high"] as const,
    assignees: ["owner", null] as const,
    tagIds: [alpha, beta],
  };
  expect(taskFilterCount(filters)).toBe(9);
  expect(matchesTaskFilters(task, filters)).toBe(true);
  expect(
    matchesTaskFilters(
      {
        ...task,
        status: "not-started",
        priority: null,
        assignee: "owner",
        tagIds: [alpha],
      },
      filters,
    ),
  ).toBe(true);
  expect(matchesTaskFilters({ ...task, status: "in-review" }, filters)).toBe(
    false,
  );
  expect(matchesTaskFilters({ ...task, priority: "low" }, filters)).toBe(false);
  expect(matchesTaskFilters({ ...task, assignee: "oru" }, filters)).toBe(false);
  expect(matchesTaskFilters({ ...task, tagIds: [gamma] }, filters)).toBe(false);
  expect(matchesTaskFilters({ ...task, status: "completed" }, filters)).toBe(
    true,
  );
});

it("sets only the status criteria for each named task list", () => {
  for (const [list, statuses] of [
    ["active", ["not-started", "in-progress", "in-review"]],
    ["complete", ["completed"]],
    ["all", taskStatuses],
  ] as const) {
    const filters = taskListFilters[list];
    expect(
      taskStatuses.filter((status) =>
        matchesTaskFilters({ ...task, status }, filters),
      ),
    ).toEqual(statuses);
    expect(filters.priorities).toEqual([]);
    expect(filters.assignees).toEqual([]);
    expect(filters.tagIds).toEqual([]);
  }
});

it("can add and remove an unassigned filter alongside a named assignee", () => {
  const assignees = toggleFilter(["oru" as const], null);
  const filters = { ...emptyFilters, assignees };
  expect(matchesTaskFilters(task, filters)).toBe(true);
  expect(matchesTaskFilters({ ...task, assignee: "oru" }, filters)).toBe(true);
  expect(matchesTaskFilters({ ...task, assignee: "owner" }, filters)).toBe(
    false,
  );
  expect(toggleFilter(assignees, null)).toEqual(["oru"]);
});

it("can select either closed status by itself", () => {
  for (const selected of ["completed", "canceled"] as const) {
    const filters = { ...emptyFilters, statuses: [selected] };
    expect(
      taskStatuses.filter((status) =>
        matchesTaskFilters({ ...task, status }, filters),
      ),
    ).toEqual([selected]);
  }
});

it("toggles Not started without removing other selections", () => {
  const selected = toggleFilter(["in-progress"], "not-started");
  expect(selected).toEqual(["in-progress", "not-started"]);
  expect(toggleFilter(selected, "not-started")).toEqual(["in-progress"]);
});

it("allows all tasks through when no values are selected", () => {
  expect(taskFilterCount(emptyFilters)).toBe(0);
  for (const status of taskStatuses)
    expect(matchesTaskFilters({ ...task, status }, emptyFilters)).toBe(true);
});
