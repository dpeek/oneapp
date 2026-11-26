import type { filesChanged } from "./files-contract.ts";
import type { inboxChanged } from "./inbox-contract.ts";
import { tagsChanged } from "./items-contract.ts";
import { tasksChanged } from "./tasks-contract.ts";

export const workspaceEventsPath = "/api/workspace/events";
export const taskRunnerEventsPath = `${workspaceEventsPath}/tasks`;

export const isTaskQueueChange = (change: unknown) =>
  change === tasksChanged || change === tagsChanged;

export type ItemChange =
  typeof filesChanged | typeof tagsChanged | typeof tasksChanged;
export type WorkspaceChange = ItemChange | typeof inboxChanged;
export type NotifyItemChange = (account: string, change: ItemChange) => void;
