import { $createCodeNode, $isCodeNode } from "@lexical/code-core";
import { $createLinkNode, $isLinkNode } from "@lexical/link";
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  type ListNode,
} from "@lexical/list";
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
  type HeadingTagType,
} from "@lexical/rich-text";
import { Schema } from "effect";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $isLineBreakNode,
  $isParagraphNode,
  $isTextNode,
  $setState,
  createState,
  DecoratorNode,
  ElementNode,
  type LexicalNode,
  type TextFormatType,
} from "lexical";
import type {
  Image,
  List,
  Paragraph,
  PhrasingContent,
  RootContent,
} from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import { ItemId } from "./items-contract.ts";
import { parseMarkdown, markdownImageBlock } from "./markdown-images.ts";

const softBreak = createState("taskDescriptionSoftBreak", {
  parse: (value) => value === true,
});
const listSpread = createState("taskDescriptionListSpread", {
  parse: (value) => value === true,
});
const itemSpread = createState("taskDescriptionItemSpread", {
  parse: (value) => value === true,
});
const codeMeta = createState("taskDescriptionCodeMeta", {
  parse: (value) => (typeof value === "string" ? value : null),
});
const preservedMarkdown = createState("markdown", {
  parse: (value) => (typeof value === "string" ? value : ""),
});
const trailingParagraph = createState("taskDescriptionTrailingParagraph", {
  parse: (value) => value === true,
});

const ImageData = Schema.Struct({
  url: Schema.String,
  alt: Schema.String,
  title: Schema.NullOr(Schema.String),
  uploadId: Schema.NullOr(ItemId),
});
type ImageData = typeof ImageData.Type;
const imageData = createState("image", {
  parse: (value): ImageData =>
    Schema.is(ImageData)(value)
      ? value
      : { url: "", alt: "", title: null, uploadId: null },
});

export class MarkdownImageNode extends DecoratorNode<null> {
  $config() {
    return this.config("task-description-image", {
      extends: DecoratorNode<null>,
      stateConfigs: [{ flat: true, stateConfig: imageData }],
    });
  }

  isInline() {
    return false;
  }

  getImage() {
    return $getState(this, imageData);
  }

  createDOM() {
    const { alt, title } = this.getImage();
    const figure = document.createElement("figure");
    figure.className = "task-description-image";
    figure.contentEditable = "false";
    const image = document.createElement("img");
    image.alt = alt;
    image.loading = "lazy";
    image.draggable = false;
    if (title) image.title = title;
    image.hidden = true;
    const status = document.createElement("figcaption");
    status.setAttribute("role", "status");
    figure.append(image, status);
    return figure;
  }

  updateDOM() {
    return false;
  }
}

export const $createMarkdownImage = (image: ImageData) =>
  $setState(new MarkdownImageNode(), imageData, image);

export const $createTrailingParagraph = () =>
  $setState($createParagraphNode(), trailingParagraph, true);

// Keep a Markdown block the editor cannot represent as a single document node.
// Its preview is inert text, including when the Markdown contains HTML.
export class PreservedMarkdownNode extends DecoratorNode<null> {
  $config() {
    return this.config("task-description-preserved", {
      extends: DecoratorNode<null>,
      stateConfigs: [{ flat: true, stateConfig: preservedMarkdown }],
    });
  }

  isInline() {
    return false;
  }

  getTextContent() {
    return $getState(this, preservedMarkdown);
  }

  createDOM() {
    const preview = document.createElement("div");
    preview.className = "task-description-preserved";
    preview.contentEditable = "false";
    preview.textContent = this.getTextContent();
    return preview;
  }

  updateDOM() {
    return false;
  }
}

export const taskDescriptionLink = (value: string) => {
  const href = value.trim();
  if (!href || /[\s\\\p{Cc}]/u.test(href)) return null;
  const parsed = URL.parse(href, "https://relative.invalid/");
  return parsed && ["http:", "https:", "mailto:"].includes(parsed.protocol)
    ? href
    : null;
};

const supportsInline = (node: PhrasingContent): boolean => {
  switch (node.type) {
    case "text":
    case "break":
    case "inlineCode":
      return true;
    case "strong":
    case "emphasis":
      return node.children.every(supportsInline);
    case "link":
      return (
        !!taskDescriptionLink(node.url) && node.children.every(supportsInline)
      );
    default:
      return false;
  }
};

const supportsBlock = (node: RootContent): boolean => {
  switch (node.type) {
    case "heading":
    case "paragraph":
      return node.children.every(supportsInline);
    case "code":
      return true;
    case "blockquote":
      return (
        node.children.length === 0 ||
        (node.children.length === 1 &&
          node.children[0]?.type === "paragraph" &&
          supportsBlock(node.children[0]))
      );
    case "list":
      return node.children.every(
        ({ children, checked }) =>
          !(node.ordered && checked != null) &&
          children.filter((child) => child.type === "paragraph").length <= 1 &&
          children.every(
            (child, index) =>
              (child.type === "list" ||
                (index === 0 && child.type === "paragraph")) &&
              supportsBlock(child),
          ),
      );
    default:
      return false;
  }
};

type DescriptionBlock =
  RootContent | Image | { type: "preserved"; value: string } | null;

export const parseDescription = (
  markdown: string,
  imageCollection?: string,
) => {
  const root = parseMarkdown(markdown);
  const blocks: DescriptionBlock[] = [];
  let previousLine = 0;
  for (const block of root.children) {
    const start = block.position?.start.line ?? previousLine + 1;
    const standardGap = previousLine ? 2 : 1;
    for (let line = previousLine + standardGap; line < start; line++)
      blocks.push(null);
    const offsets = block.position;
    const image = imageCollection && markdownImageBlock(block, imageCollection);
    if (image) {
      blocks.push(image.image);
    } else if (supportsBlock(block) || !offsets) {
      blocks.push(block);
    } else {
      let from = offsets.start.offset ?? 0;
      let to = offsets.end.offset ?? markdown.length;
      while (from > 0 && /[ \t]/u.test(markdown.charAt(from - 1))) from--;
      while (/[ \t]/u.test(markdown.charAt(to))) to++;
      blocks.push({ type: "preserved", value: markdown.slice(from, to) });
    }
    previousLine = block.position?.end.line ?? start;
  }
  const lastLine = root.position?.end.line ?? 1;
  const trailing = lastLine - previousLine - 1;
  for (let line = 0; line < trailing; line++) blocks.push(null);
  return blocks;
};

const $appendText = (
  parent: ElementNode,
  value: string,
  formats: TextFormatType[],
  soft = false,
) => {
  for (const [index, line] of value.split("\n").entries()) {
    if (index)
      parent.append($setState($createLineBreakNode(), softBreak, soft));
    if (!line) continue;
    const text = $createTextNode(line);
    for (const format of formats) text.toggleFormat(format);
    parent.append(text);
  }
};

const $appendInline = (
  parent: ElementNode,
  children: PhrasingContent[],
  formats: TextFormatType[] = [],
) => {
  for (const child of children) {
    switch (child.type) {
      case "text":
        $appendText(parent, child.value, formats, true);
        break;
      case "break":
        parent.append($createLineBreakNode());
        break;
      case "inlineCode":
        $appendText(parent, child.value, [...formats, "code"]);
        break;
      case "strong":
        $appendInline(parent, child.children, [...formats, "bold"]);
        break;
      case "emphasis":
        $appendInline(parent, child.children, [...formats, "italic"]);
        break;
      case "link": {
        const link = $createLinkNode(child.url, { title: child.title });
        $appendInline(link, child.children, formats);
        parent.append(link);
        break;
      }
    }
  }
};

const $appendList = (parent: ElementNode, source: List) => {
  let list: ListNode | undefined;
  for (const [index, child] of source.children.entries()) {
    const type = source.ordered
      ? "number"
      : child.checked == null
        ? "bullet"
        : "check";
    if (list?.getListType() !== type) {
      list = $createListNode(type, (source.start ?? 1) + index);
      $setState(list, listSpread, source.spread === true);
      parent.append(list);
    }
    const item = $createListItemNode(child.checked ?? undefined);
    list.append($setState(item, itemSpread, child.spread === true));
    for (const block of child.children) {
      if (block.type === "paragraph") {
        const [text] = block.children;
        // GFM encodes an empty checklist label as a space.
        if (
          child.checked == null ||
          block.children.length !== 1 ||
          text?.type !== "text" ||
          text.value !== " "
        )
          $appendInline(item, block.children);
      }
      if (block.type === "list") {
        // Lexical keeps nested lists in their own wrapper items, immediately
        // after the visible item that owns them.
        const nested = $createListItemNode();
        $appendList(nested, block);
        for (const entry of nested.getChildren()) {
          list.append($createListItemNode().append(entry));
        }
      }
    }
  }
};

export const $loadDescription = (blocks: DescriptionBlock[]) => {
  const root = $getRoot().clear();
  for (const block of blocks) {
    if (!block) {
      root.append($createParagraphNode());
      continue;
    }
    switch (block.type) {
      case "image":
        root.append(
          $createMarkdownImage({
            url: block.url,
            alt: block.alt ?? "",
            title: block.title ?? null,
            uploadId: null,
          }),
        );
        break;
      case "paragraph":
      case "heading": {
        const node =
          block.type === "paragraph"
            ? $createParagraphNode()
            : $createHeadingNode(`h${block.depth}` as HeadingTagType);
        $appendInline(node, block.children);
        root.append(node);
        break;
      }
      case "blockquote": {
        const node = $createQuoteNode();
        const paragraph = block.children[0];
        if (paragraph?.type === "paragraph")
          $appendInline(node, paragraph.children);
        root.append(node);
        break;
      }
      case "code": {
        const node = $createCodeNode(block.lang);
        $setState(node, codeMeta, block.meta ?? null);
        $appendText(node, block.value, []);
        root.append(node);
        break;
      }
      case "list":
        $appendList(root, block);
        break;
      case "preserved":
        root.append(
          $setState(
            new PreservedMarkdownNode(),
            preservedMarkdown,
            block.value,
          ),
        );
        break;
    }
  }
  if (root.isEmpty()) root.append($createParagraphNode());
  const last = root.getLastChild();
  if (
    last instanceof PreservedMarkdownNode ||
    last instanceof MarkdownImageNode
  )
    root.append($createTrailingParagraph());
};

const appendInline = (children: PhrasingContent[], node: PhrasingContent) => {
  const previous = children.at(-1);
  if (node.type === "text" && previous?.type === "text") {
    previous.value += node.value;
  } else if (
    (node.type === "emphasis" && previous?.type === "emphasis") ||
    (node.type === "strong" && previous?.type === "strong")
  ) {
    for (const child of node.children) appendInline(previous.children, child);
  } else children.push(node);
};

const $inline = (nodes: LexicalNode[]): PhrasingContent[] => {
  const children: PhrasingContent[] = [];
  for (const node of nodes) {
    if ($isTextNode(node)) {
      const value = node.getTextContent();
      if (!value) continue;
      let text: PhrasingContent = {
        type: node.hasFormat("code") ? "inlineCode" : "text",
        value,
      };
      if (node.hasFormat("italic"))
        text = { type: "emphasis", children: [text] };
      if (node.hasFormat("bold")) text = { type: "strong", children: [text] };
      appendInline(children, text);
    } else if ($isLinkNode(node)) {
      const contents = $inline(node.getChildren());
      if (taskDescriptionLink(node.getURL())) {
        children.push({
          type: "link",
          url: node.getURL(),
          title: node.getTitle(),
          children: contents,
        });
      } else {
        for (const child of contents) appendInline(children, child);
      }
    } else if ($isLineBreakNode(node)) {
      appendInline(
        children,
        $getState(node, softBreak)
          ? { type: "text", value: "\n" }
          : { type: "break" },
      );
    }
  }
  return children;
};

const $paragraph = (node: ElementNode): Paragraph => ({
  type: "paragraph",
  children: $inline(node.getChildren()),
});

const $markdownList = (node: ListNode): List => {
  const ordered = node.getListType() === "number";
  const list: List = {
    type: "list",
    ordered,
    start: ordered ? node.getStart() : null,
    spread: $getState(node, listSpread),
    children: [],
  };
  for (const item of node.getChildren()) {
    if (!$isListItemNode(item)) continue;
    const first = item.getFirstChild();
    if ($isListNode(first) && list.children.length) {
      list.children.at(-1)?.children.push($markdownList(first));
    } else {
      const paragraph = $paragraph(item);
      const checked = item.getChecked();
      list.children.push({
        type: "listItem",
        checked,
        spread: $getState(item, itemSpread),
        children: $isListNode(first)
          ? [$markdownList(first)]
          : paragraph.children.length || checked != null
            ? [paragraph]
            : [],
      });
    }
  }
  return list;
};

const $block = (node: LexicalNode): RootContent | undefined => {
  if (node instanceof MarkdownImageNode) {
    const { url, alt, title } = node.getImage();
    return {
      type: "paragraph",
      children: [{ type: "image", url, alt, title }],
    };
  }
  if (node instanceof PreservedMarkdownNode) {
    // mdast emits HTML blocks verbatim, which is also how we emit opaque Markdown.
    return { type: "html", value: node.getTextContent() };
  }
  if ($isHeadingNode(node)) {
    return {
      type: "heading",
      depth: Number(node.getTag().slice(1)) as 1 | 2 | 3 | 4 | 5 | 6,
      children: $inline(node.getChildren()),
    };
  }
  if ($isQuoteNode(node)) {
    return { type: "blockquote", children: [$paragraph(node)] };
  }
  if ($isCodeNode(node)) {
    return {
      type: "code",
      lang: node.getLanguage(),
      meta: $getState(node, codeMeta),
      value: node.getTextContent(),
    };
  }
  if ($isListNode(node)) return $markdownList(node);
  if ($isParagraphNode(node) && !node.isEmpty()) return $paragraph(node);
};

export const $serializeDescription = (
  uploaded: (id: string) => boolean = () => false,
) => {
  const children: RootContent[] = [];
  const gaps = new Map<RootContent, number>();
  let empty = 0;
  for (const node of $getRoot().getChildren()) {
    if (node instanceof MarkdownImageNode) {
      const { uploadId } = node.getImage();
      if (uploadId && !uploaded(uploadId)) continue;
    }
    const block = $block(node);
    if (block) {
      gaps.set(block, empty);
      children.push(block);
      empty = 0;
    } else if (node.getNextSibling() || !$getState(node, trailingParagraph)) {
      empty++;
    }
  }
  if (!children.length) return "\n".repeat(Math.max(0, empty - 1));
  const first = children[0];
  const markdown = toMarkdown(
    { type: "root", children },
    {
      bullet: "-",
      fences: true,
      extensions: [gfmToMarkdown()],
      join: [
        (left, right, parent) => {
          // Adjacent bullet and check groups share the same Markdown list.
          if (
            left.type === "list" &&
            right.type === "list" &&
            !left.ordered &&
            !right.ordered &&
            left.spread === right.spread &&
            !gaps.get(right)
          )
            return left.spread ? 1 : 0;
          if (parent.type === "root") return 1 + (gaps.get(right) ?? 0);
        },
      ],
    },
  ).replace(/\n$/u, "");
  return (
    "\n".repeat(first ? (gaps.get(first) ?? 0) : 0) +
    markdown +
    "\n".repeat(empty ? empty + 1 : 0)
  );
};
