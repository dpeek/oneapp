import { Schema } from "effect";
import type { RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { ItemId } from "./items-contract.ts";
import { taskAttachmentsApi } from "./task-attachment-contract.ts";

export const parseTaskMarkdown = (markdown: string) =>
  fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

export const taskImageId = (taskId: string, url: string) => {
  const prefix = `${taskAttachmentsApi(taskId)}/`;
  if (!url.startsWith(prefix)) return null;
  const id = url.slice(prefix.length);
  return Schema.is(ItemId)(id) ? id : null;
};

export const taskImageBlock = (block: RootContent, taskId: string) => {
  if (block.type !== "paragraph" || block.children.length !== 1) return null;
  const image = block.children[0];
  if (image?.type !== "image") return null;
  const id = taskImageId(taskId, image.url);
  return id ? { id, image } : null;
};

export const taskImageIds = (markdown: string, taskId: string) => {
  const ids = new Set<string>();
  const visit = (node: ReturnType<typeof parseTaskMarkdown> | RootContent) => {
    if (node.type === "image") {
      const id = taskImageId(taskId, node.url);
      if (id) ids.add(id);
    } else if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  if (markdown.includes("![")) visit(parseTaskMarkdown(markdown));
  return ids;
};

export const omitTaskImageBlocks = (
  markdown: string,
  taskId: string,
  ids: ReadonlySet<string>,
) => {
  if (!ids.size) return markdown;
  let result = markdown;
  for (const block of parseTaskMarkdown(markdown).children.reverse()) {
    const local = taskImageBlock(block, taskId);
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
