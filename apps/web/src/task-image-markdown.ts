import { taskAttachmentsApi } from "./task-attachment-contract.ts";
import {
  markdownImageBlock,
  markdownImageId,
  markdownImageIds,
  parseMarkdown,
} from "./markdown-images.ts";

export const taskImageId = (taskId: string, url: string) =>
  markdownImageId(taskAttachmentsApi(taskId), url);

export const taskImageIds = (markdown: string, taskId: string) =>
  markdownImageIds(markdown, taskAttachmentsApi(taskId));

export const omitTaskImageBlocks = (
  markdown: string,
  taskId: string,
  ids: ReadonlySet<string>,
) => {
  if (!ids.size) return markdown;
  let result = markdown;
  for (const block of parseMarkdown(markdown).children.reverse()) {
    const local = markdownImageBlock(block, taskAttachmentsApi(taskId));
    const start = block.position?.start.offset;
    const end = block.position?.end.offset;
    if (
      !local ||
      !ids.has(local.id) ||
      start === undefined ||
      end === undefined
    )
      continue;
    const before = result.slice(0, start);
    const after = result.slice(end);
    result = after
      ? before + after.replace(/^(?:\r?\n){1,2}/u, "")
      : before.replace(/(?:\r?\n){1,2}$/u, "");
  }
  return result;
};
