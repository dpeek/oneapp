import type { filesChanged } from "./files-contract.ts";
import type { inboxChanged } from "./inbox-contract.ts";
import type { tagsChanged } from "./items-contract.ts";
import type { tasksChanged } from "./tasks-contract.ts";

export type ItemChange =
  typeof filesChanged | typeof tagsChanged | typeof tasksChanged;
export type WorkspaceChange = ItemChange | typeof inboxChanged;
export type NotifyItemChange = (account: string, change: ItemChange) => void;
