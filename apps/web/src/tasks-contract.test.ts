import { expect, it } from "@effect/vitest";
import {
  taskListPath,
  taskPath,
  taskRouteFor,
  tasksPath,
} from "./tasks-contract.ts";

const id = "00000000-0000-4000-8000-000000000000";

it("routes named task lists and preserves task permalinks", () => {
  expect(tasksPath).toBe("/tasks");
  for (const [list, path] of [
    ["active", "/tasks"],
    ["complete", "/tasks/complete"],
    ["all", "/tasks/all"],
  ] as const) {
    expect(taskListPath(list)).toBe(path);
    expect(taskRouteFor(path)).toEqual({ id: null, list });
    expect(taskRouteFor(`${path}/`)).toEqual({ id: null, list });
  }
  const detail = taskPath(id);
  expect(detail).toBe(`/tasks/${id}`);
  expect(taskRouteFor(detail)).toEqual({ id, list: null });
  expect(taskRouteFor(`${detail}/`)).toEqual({ id, list: null });
  expect(taskRouteFor(`${tasksPath}/invalid`)).toBeNull();
  expect(taskRouteFor(`${detail}/invalid`)).toBeNull();
  expect(taskRouteFor("/tasks-other")).toBeNull();
});
