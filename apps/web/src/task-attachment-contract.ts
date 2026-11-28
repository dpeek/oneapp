import { Schema } from "effect";
import { FileName } from "./files-contract.ts";
import { ImageMediaType, imageUploadLimit } from "./image-upload.ts";
import { ItemId } from "./items-contract.ts";
import { taskApi } from "./tasks-contract.ts";

export const taskAttachmentsApi = (taskId: string) =>
  `${taskApi(taskId)}/attachments` as const;
export const taskAttachmentApi = (taskId: string, attachmentId: string) =>
  `${taskAttachmentsApi(taskId)}/${attachmentId}` as const;

export const taskAttachmentIdHeader = "x-task-attachment-id";
export const taskInlineImageHeader = "x-task-inline-image";

export {
  imageUploadLimitMiB as taskAttachmentLimitMiB,
  imageUploadLimit as taskAttachmentLimit,
  ImageMediaType as TaskAttachmentMediaType,
} from "./image-upload.ts";

export const TaskAttachment = Schema.Struct({
  id: ItemId,
  name: FileName,
  mediaType: ImageMediaType,
  size: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: imageUploadLimit }),
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
