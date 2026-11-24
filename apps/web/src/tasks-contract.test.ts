import { expect, it } from "@effect/vitest";
import { taskListPath, taskPath, taskRouteFor } from "./tasks-contract.ts";

const id = "00000000-0000-4000-8000-000000000000";

it("routes task lists and detail links within their view", () => {
  for (const view of ["active", "completed"] as const) {
    const list = taskListPath(view);
    const detail = taskPath(id, view);
    expect(taskRouteFor(list)).toEqual({ view, id: null });
    expect(taskRouteFor(`${list}/`)).toEqual({ view, id: null });
    expect(taskRouteFor(detail)).toEqual({ view, id });
    expect(taskRouteFor(`${detail}/`)).toEqual({ view, id });
    expect(taskRouteFor(`${list}/invalid`)).toBeNull();
    expect(taskRouteFor(`${detail}/invalid`)).toBeNull();
  }
  expect(taskListPath("completed")).toBe("/tasks/completed");
});

it("keeps existing task permalinks and defaults to Active", () => {
  expect(taskRouteFor("/tasks")).toEqual({ view: "active", id: null });
  expect(taskPath(id)).toBe(`/tasks/${id}`);
  expect(taskRouteFor(taskPath(id))).toEqual({ view: "active", id });
  expect(taskRouteFor("/tasks-other")).toBeNull();
});
