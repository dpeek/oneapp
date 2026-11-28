import { taskAttachmentsApi } from "./task-attachment-contract.ts";
import { describe, expect, it } from "@effect/vitest";
import { CodeNode } from "@lexical/code-core";
import { LinkNode } from "@lexical/link";
import {
  $createListItemNode,
  $createListNode,
  ListItemNode,
  ListNode,
  registerList,
} from "@lexical/list";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { $createTextNode, $getRoot, createEditor } from "lexical";
import { taskAttachmentApi } from "./task-attachment-contract.ts";
import { omitTaskImageBlocks } from "./task-image-markdown.ts";
import {
  $createMarkdownImage,
  $loadDescription,
  $serializeDescription,
  parseDescription,
  PreservedMarkdownNode,
  MarkdownImageNode,
} from "./markdown.ts";

describe("task description Markdown", () => {
  it("preserves mixed nested blocks, check states, mail links and hard breaks after an edit", () => {
    const editor = createEditor({
      nodes: [
        HeadingNode,
        QuoteNode,
        CodeNode,
        ListNode,
        ListItemNode,
        LinkNode,
      ],
    });
    const unregister = registerList(editor);
    const markdown = [
      "## **Work**",
      "",
      "Read *updates* and `logs`.  ",
      "[Original email](/app/mail#message-fixture)",
      "",
      "",
      "> First line\\",
      "> Second line",
      "",
      "1. Top",
      "   - Child",
      "   - [x] Complete",
      "   - [ ] Pending",
      "",
      "```ts title=fixture",
      "const x = 1;",
      "```",
    ].join("\n");
    editor.update(
      () => {
        $loadDescription(parseDescription(markdown));
        $getRoot()
          .getFirstChildOrThrow()
          .selectEnd()
          .insertNodes([$createTextNode(" today")]);
      },
      { discrete: true },
    );
    const encoded = editor.read($serializeDescription);
    expect(encoded).toContain("## **Work** today");
    expect(encoded).toContain(
      "[Original email](/app/mail#message-fixture)\n\n\n>",
    );
    expect(encoded).toMatch(/logs`\.(?: {2}|\\)\n\[Original email\]/u);
    expect(encoded).toMatch(/> First line(?: {2}|\\)\n> Second line/u);
    expect(encoded).toMatch(
      /1\. Top\n   [-*] Child\n   [-*] \[x\] Complete\n   [-*] \[ \] Pending/u,
    );
    expect(encoded).toContain("```ts title=fixture\nconst x = 1;\n```");
    unregister();
  });

  it("preserves unsupported Markdown verbatim when neighboring content is edited", () => {
    const editor = createEditor({ nodes: [PreservedMarkdownNode] });
    const unsupported = [
      "| Name |\n| ---- |\n| Data |",
      "[Source][link]\n\n  [link]: /app/mail#message-fixture",
      "![Screenshot](/api/tasks/fixture/attachments/fixture)",
      "> A paragraph\n>\n> Another paragraph",
      "<div>Raw HTML</div>",
    ].join("\n\n");
    const markdown = `Editable text\n\n${unsupported}`;

    editor.update(() => $loadDescription(parseDescription(markdown)), {
      discrete: true,
    });
    expect(editor.read($serializeDescription)).toBe(markdown);

    editor.update(
      () => {
        $getRoot().getFirstChildOrThrow().selectEnd().insertText(" today");
        $getRoot().getLastChildOrThrow().selectEnd().insertText("Another edit");
      },
      { discrete: true },
    );
    const edited = `Editable text today\n\n${unsupported}\n\nAnother edit`;
    expect(editor.read($serializeDescription)).toBe(edited);

    editor.update(() => $loadDescription(parseDescription(edited)), {
      discrete: true,
    });
    expect(editor.read($serializeDescription)).toBe(edited);
  });

  it("round trips an empty checklist item as a checkbox", () => {
    const editor = createEditor({ nodes: [ListNode, ListItemNode] });
    editor.update(
      () => {
        $getRoot().append(
          $createListNode("check").append($createListItemNode(false)),
        );
      },
      { discrete: true },
    );
    const markdown = editor.read($serializeDescription);
    expect(markdown).toMatch(/^- \[ \]/u);
    const blocks = parseDescription(markdown);
    expect(blocks[0]).toMatchObject({
      type: "list",
      children: [{ checked: false }],
    });
    editor.update(() => $loadDescription(blocks), { discrete: true });
    expect(editor.read(() => $getRoot().getTextContent())).toBe("");
  });

  it("renders only stand-alone images from the task's attachment route", () => {
    const taskId = crypto.randomUUID();
    const imageId = crypto.randomUUID();
    const url = taskAttachmentApi(taskId, imageId);
    const source = [
      `![Local](${url} "Screenshot")`,
      `![Other task](${taskAttachmentApi(crypto.randomUUID(), imageId)})`,
      "![Remote](https://example.com/image.png)",
      `Before ![Inline](${url}) after`,
    ].join("\n\n");
    const editor = createEditor({
      nodes: [MarkdownImageNode, PreservedMarkdownNode],
    });
    editor.update(
      () =>
        $loadDescription(parseDescription(source, taskAttachmentsApi(taskId))),
      {
        discrete: true,
      },
    );
    expect(
      editor.read(() =>
        $getRoot()
          .getChildren()
          .map((node) => node.getType()),
      ),
    ).toEqual([
      MarkdownImageNode.getType(),
      PreservedMarkdownNode.getType(),
      PreservedMarkdownNode.getType(),
      PreservedMarkdownNode.getType(),
      "paragraph",
    ]);
    expect(editor.read($serializeDescription)).toBe(source);
  });

  it("serializes a pasted image only after the upload succeeds", () => {
    const uploadId = crypto.randomUUID();
    const url = taskAttachmentApi(crypto.randomUUID(), uploadId);
    const editor = createEditor({ nodes: [MarkdownImageNode] });
    editor.update(
      () => {
        $getRoot().append(
          $createMarkdownImage({ url, alt: "Pasted", title: null, uploadId }),
        );
      },
      { discrete: true },
    );
    expect(editor.read($serializeDescription)).toBe("");
    expect(
      editor.read(() => $serializeDescription((id) => id === uploadId)),
    ).toBe(`![Pasted](${url})`);
  });

  it("omits unfinished draft images while preserving text and successful images", () => {
    const taskId = crypto.randomUUID();
    const failed = crypto.randomUUID();
    const omitted = `![Pending](${taskAttachmentApi(taskId, failed)})`;
    const saved = `![Saved](${taskAttachmentApi(taskId, crypto.randomUUID())})`;
    const markdown = ["Before", omitted, saved, "After", omitted].join("\n\n");
    expect(omitTaskImageBlocks(markdown, taskId, new Set([failed]))).toBe(
      ["Before", saved, "After"].join("\n\n"),
    );
  });
});
