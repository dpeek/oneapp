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
import {
  $loadDescription,
  $serializeDescription,
  parseDescription,
} from "./task-description-markdown.ts";

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
      "[Original email](/mail#message-fixture)",
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
    const parsed = parseDescription(markdown);
    expect(parsed).not.toBeNull();
    editor.update(
      () => {
        $loadDescription(parsed ?? []);
        $getRoot()
          .getFirstChildOrThrow()
          .selectEnd()
          .insertNodes([$createTextNode(" today")]);
      },
      { discrete: true },
    );
    const encoded = editor.read($serializeDescription);
    expect(encoded).toContain("## **Work** today");
    expect(encoded).toContain("[Original email](/mail#message-fixture)\n\n\n>");
    expect(encoded).toMatch(/logs`\.(?: {2}|\\)\n\[Original email\]/u);
    expect(encoded).toMatch(/> First line(?: {2}|\\)\n> Second line/u);
    expect(encoded).toMatch(
      /1\. Top\n   [-*] Child\n   [-*] \[x\] Complete\n   [-*] \[ \] Pending/u,
    );
    expect(encoded).toContain("```ts title=fixture\nconst x = 1;\n```");
    expect(parseDescription(encoded)).not.toBeNull();
    unregister();
  });

  it("uses source for Markdown outside the visual editor's supported structure", () => {
    for (const markdown of [
      "| Name |\n| ---- |\n| Data |",
      "[Source][link]\n\n[link]: /mail#message-fixture",
      "![Screenshot](/api/tasks/fixture/attachments/fixture)",
      "> A paragraph\n>\n> Another paragraph",
    ])
      expect(parseDescription(markdown)).toBeNull();
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
    expect(blocks?.[0]).toMatchObject({
      type: "list",
      children: [{ checked: false }],
    });
    editor.update(() => $loadDescription(blocks ?? []), { discrete: true });
    expect(editor.read(() => $getRoot().getTextContent())).toBe("");
  });
});
