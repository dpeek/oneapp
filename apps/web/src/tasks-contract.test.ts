import { expect, it } from "@effect/vitest";
import { taskPath, taskRouteFor, tasksPath } from "./tasks-contract.ts";

const id = "00000000-0000-4000-8000-000000000000";

it("routes the task list and preserves task permalinks", () => {
  expect(tasksPath).toBe("/tasks");
  const detail = taskPath(id);
  expect(detail).toBe(`/tasks/${id}`);
  expect(taskRouteFor(tasksPath)).toEqual({ id: null });
  expect(taskRouteFor(`${tasksPath}/`)).toEqual({ id: null });
  expect(taskRouteFor(detail)).toEqual({ id });
  expect(taskRouteFor(`${detail}/`)).toEqual({ id });
  expect(taskRouteFor(`${tasksPath}/invalid`)).toBeNull();
  expect(taskRouteFor(`${detail}/invalid`)).toBeNull();
  expect(taskRouteFor("/tasks-other")).toBeNull();
});
