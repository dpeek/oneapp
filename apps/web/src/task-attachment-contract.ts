import { Schema } from "effect";
import { FileName } from "./files-contract.ts";
import { ItemId } from "./items-contract.ts";
import { taskApi } from "./tasks-contract.ts";

export const taskAttachmentsApi = (taskId: string) =>
  `${taskApi(taskId)}/attachments` as const;
export const taskAttachmentApi = (taskId: string, attachmentId: string) =>
  `${taskAttachmentsApi(taskId)}/${attachmentId}` as const;

export const taskAttachmentIdHeader = "x-task-attachment-id";

export const taskAttachmentLimitMiB = 5;
export const taskAttachmentLimit = taskAttachmentLimitMiB * 1024 * 1024;
export const TaskAttachmentMediaType = Schema.Literals([
  "image/png",
  "image/jpeg",
]);
export const TaskAttachment = Schema.Struct({
  id: ItemId,
  name: FileName,
  mediaType: TaskAttachmentMediaType,
  size: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: taskAttachmentLimit }),
  ),
  createdAt: Schema.Number,
});
export type TaskAttachment = typeof TaskAttachment.Type;
export const TaskAttachments = Schema.Struct({
  attachments: Schema.Array(TaskAttachment),
});

const taskAttachmentPrefix = "task-attachments/";
export const taskAttachmentObjectKey = (
  account: string,
  taskId: string,
  attachmentId: string,
) => `${taskAttachmentPrefix}${account}/${taskId}/${attachmentId}`;
