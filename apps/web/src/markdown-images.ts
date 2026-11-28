import { Schema } from "effect";
import type { RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { ItemId } from "./items-contract.ts";

export const parseMarkdown = (markdown: string) =>
  fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

export const markdownImageId = (collection: string, url: string) => {
  const prefix = `${collection}/`;
  if (!url.startsWith(prefix)) return null;
  const id = url.slice(prefix.length);
  return Schema.is(ItemId)(id) ? id : null;
};

export const markdownImageBlock = (block: RootContent, collection: string) => {
  if (block.type !== "paragraph" || block.children.length !== 1) return null;
  const image = block.children[0];
  if (image?.type !== "image") return null;
  const id = markdownImageId(collection, image.url);
  return id ? { id, image } : null;
};

export const markdownImageIds = (markdown: string, collection: string) => {
  const ids = new Set<string>();
  const visit = (node: ReturnType<typeof parseMarkdown> | RootContent) => {
    if (node.type === "image") {
      const id = markdownImageId(collection, node.url);
      if (id) ids.add(id);
    } else if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  if (markdown.includes("![")) visit(parseMarkdown(markdown));
  return ids;
};
