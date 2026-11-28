import {
  autoUpdate,
  computePosition,
  flip,
  hide,
  inline,
  offset,
  shift,
  type VirtualElement,
} from "@floating-ui/dom";
import {
  $createCodeNode,
  $isCodeNode,
  CodeExtension,
} from "@lexical/code-core";
import { buildEditorFromExtensions } from "@lexical/extension";
import { $isLinkNode, $toggleLink, LinkExtension } from "@lexical/link";
import {
  $createListItemNode,
  $createListNode,
  $insertList,
  $isListItemNode,
  $isListNode,
  ListItemNode,
  ListNode,
  registerCheckList,
  registerList,
  type ListType,
} from "@lexical/list";
import {
  CHECK_LIST,
  LINK,
  TRANSFORMERS,
  registerMarkdownShortcuts,
  type TextMatchTransformer,
} from "@lexical/markdown";
import { createEmptyHistoryState, registerHistory } from "@lexical/history";
import {
  $createHeadingNode,
  $createQuoteNode,
  HeadingNode,
  QuoteNode,
  registerRichText,
  type HeadingTagType,
} from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import {
  buttonClassName,
  compactToggleClassName,
  documentTypography,
  inputClassName,
  linkIconPaths,
  taskIconPaths,
  toolbarClassName,
  trashIconPaths,
} from "@orumai/ui";
import {
  $addUpdateTag,
  $createParagraphNode,
  $findMatchingParent,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_HIGH,
  DROP_COMMAND,
  FORMAT_TEXT_COMMAND,
  HISTORIC_TAG,
  INDENT_CONTENT_COMMAND,
  KEY_SPACE_COMMAND,
  KEY_TAB_COMMAND,
  OUTDENT_CONTENT_COMMAND,
  PASTE_COMMAND,
  PASTE_TAG,
  SKIP_DOM_SELECTION_TAG,
  TEXT_TYPE_TO_FORMAT,
  defineExtension,
  mergeRegister,
  type ElementNode,
  type LexicalNode,
  type NodeKey,
  type RangeSelection,
  type TextFormatType,
} from "lexical";
import {
  markdownEditor,
  type InlineImageUploads,
} from "./markdown-editor-contract.ts";
import {
  $createMarkdownImage,
  $createTrailingParagraph,
  $loadDescription,
  $serializeDescription,
  parseDescription,
  PreservedMarkdownNode,
  MarkdownImageNode,
  taskDescriptionLink,
} from "./markdown.ts";
import { markdownImageId } from "./markdown-images.ts";

const setBlock = (create: () => ElementNode) => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  $setBlocksType(selection, create);
};

const $selectionBlock = (selection: RangeSelection) =>
  $findMatchingParent(
    selection.anchor.getNode(),
    (node) => $isElementNode(node) && !node.isInline(),
  );

// Split a list at its selected item so changing its type leaves its neighbors
// (and any sublists belonging to the item) in place.
const $setListItemType = (item: ListItemNode, type: ListType) => {
  const list = item.getParent();
  if (!$isListNode(list) || list.getListType() === type) return;
  const replacement = $createListNode(type);
  const tail = $createListNode(list.getListType());
  const siblings = item.getNextSiblings();
  const nextVisible = siblings.find(
    (node) => $isListItemNode(node) && !$isListNode(node.getFirstChild()),
  );
  if ($isListItemNode(nextVisible)) tail.setStart(nextVisible.getValue());
  const nestedCount = nextVisible
    ? siblings.indexOf(nextVisible)
    : siblings.length;
  replacement.append(item, ...siblings.slice(0, nestedCount));
  tail.append(...siblings.slice(nestedCount));

  const wrapper = list.getParent();
  if ($isListItemNode(wrapper)) {
    wrapper.insertAfter($createListItemNode().append(replacement));
    if (!tail.isEmpty())
      replacement
        .getParentOrThrow()
        .insertAfter($createListItemNode().append(tail));
    if (list.isEmpty()) wrapper.remove();
  } else {
    list.insertAfter(replacement);
    if (!tail.isEmpty()) replacement.insertAfter(tail);
    if (list.isEmpty()) list.remove();
  }
};

const $setListType = (type: ListType) => {
  const selection = $getSelection();
  const item =
    $isRangeSelection(selection) && selection.isCollapsed()
      ? $findMatchingParent(selection.anchor.getNode(), $isListItemNode)
      : null;
  if ($isListItemNode(item)) $setListItemType(item, type);
  else $insertList(type);
};

const codeIconPaths = ["m9 6-6 6 6 6", "m15 6 6 6-6 6"] as const;

const blockChoices = [
  {
    label: "Paragraph",
    keywords: "text",
    iconPaths: ["M12 5H9a4 4 0 1 0 0 8h3M12 5v14m5-14v14M9 5h11"],
    apply: () => setBlock($createParagraphNode),
  },
  ...(
    [
      [1, "m15 10 2-2v8m-2 0h4"],
      [2, "M15 10a2 2 0 0 1 4 0c0 2-4 4-4 6h4"],
      [3, "M15 8h4l-2 4h.5a2 2 0 0 1 0 4H15"],
    ] as const
  ).map(([level, digit]) => ({
    label: `Heading ${level}`,
    keywords: "# title",
    iconPaths: ["M4 6v12M11 6v12M4 12h7", digit],
    apply: () =>
      setBlock(() => $createHeadingNode(`h${level}` as HeadingTagType)),
  })),
  {
    label: "Bulleted list",
    keywords: "- * unordered",
    iconPaths: ["M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"],
    apply: () => $setListType("bullet"),
  },
  {
    label: "Numbered list",
    keywords: "1. ordered",
    iconPaths: [
      "M10 6h10M10 12h10M10 18h10",
      "M4 5h1v5m-1 0h2M4 14a1.5 1.5 0 0 1 3 0c0 1-3 2-3 4h3",
    ],
    apply: () => $setListType("number"),
  },
  {
    label: "Checklist",
    keywords: "[] checkbox to-do task list",
    iconPaths: taskIconPaths,
    apply: () => $setListType("check"),
  },
  {
    label: "Block quote",
    keywords: "> quotation",
    iconPaths: [
      "M3 12V7h6v5H3m6 0c0 3-1.5 5-4 6",
      "M14 12V7h6v5h-6m6 0c0 3-1.5 5-4 6",
    ],
    apply: () => setBlock($createQuoteNode),
  },
  {
    label: "Code block",
    keywords: "``` fenced",
    iconPaths: codeIconPaths,
    apply: () => setBlock($createCodeNode),
  },
  {
    label: "Image",
    keywords: "upload photo picture screenshot png jpeg",
    iconPaths: [
      "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z",
      "m4 16 5-5 4 4 2-2 5 5M15 8h.01",
    ],
  },
];

const formats = [
  ["bold", "B", "Bold"],
  ["italic", "I", "Italic"],
  ["code", codeIconPaths, "Inline code"],
] as const;
const supportedFormats = new Set<TextFormatType>(
  formats.map(([format]) => format),
);

const $selectedTextNodes = (selection: RangeSelection) => {
  const [start, end] = selection.isBackward()
    ? [selection.focus, selection.anchor]
    : [selection.anchor, selection.focus];
  return selection
    .getNodes()
    .filter($isTextNode)
    .filter((node) => {
      const key = node.getKey();
      const from =
        start.type === "text" && start.key === key ? start.offset : 0;
      const to =
        end.type === "text" && end.key === key
          ? end.offset
          : node.getTextContentSize();
      return from < to;
    });
};

const $selectedLink = (selection: RangeSelection) => {
  const nodes = $selectedTextNodes(selection);
  const first = nodes[0];
  const link = first && $findMatchingParent(first, $isLinkNode);
  return link &&
    nodes.every((node) => $findMatchingParent(node, $isLinkNode) === link)
    ? link
    : null;
};

const makeOutlineIcon = (paths: readonly string[]) => {
  const svgNamespace = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(svgNamespace, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(svgNamespace, "path");
    path.setAttribute("d", d);
    icon.append(path);
  }
  return icon;
};

const makeButton = (
  content: string | Node,
  label: string,
  run?: () => void,
) => {
  const button = document.createElement("button");
  button.type = "button";
  button.append(content);
  button.title = label;
  button.setAttribute("aria-label", label);
  if (run) button.addEventListener("click", run);
  return button;
};

const descriptionExtension = defineExtension({
  name: "OrumaiTaskDescription",
  dependencies: [CodeExtension, LinkExtension],
  namespace: "OrumaiTaskDescription",
  nodes: [
    HeadingNode,
    QuoteNode,
    ListNode,
    ListItemNode,
    PreservedMarkdownNode,
    MarkdownImageNode,
  ],
  theme: {
    heading: documentTypography.heading,
    quote: documentTypography.quote,
    code: `task-description-code ${documentTypography.codeBlock}`,
    text: {
      code: documentTypography.inlineCode,
      bold: "task-description-bold",
      italic: "task-description-italic",
    },
    list: {
      checklist: "task-description-checklist",
      listitemChecked: "task-description-checked",
      listitemUnchecked: "task-description-unchecked",
      nested: { listitem: "task-description-nested" },
    },
  },
});

let nextEditorId = 0;

export class MarkdownEditor extends HTMLElement {
  #id = `task-description-${++nextEditorId}`;
  #body = document.createElement("div");
  #floating = document.createElement("div");
  #formatting = document.createElement("div");
  #menu = document.createElement("div");
  #options = document.createElement("div");
  #imageInput = document.createElement("input");
  #imageInsertionKey: NodeKey | null = null;
  #slashBlockKey: NodeKey | null = null;
  #slashQuery: string | null = null;
  #matches = blockChoices;
  #activeOption = 0;
  #link = document.createElement("div");
  #url = document.createElement("input");
  #linkError = document.createElement("span");
  #linkButton = makeButton(
    makeOutlineIcon(linkIconPaths),
    "Add or edit link",
    () => this.#openLink(),
  );
  #removeLink = makeButton("Remove", "Remove link", () =>
    this.#applyLink(true),
  );
  #error = document.createElement("p");
  #formatButtons = new Map<(typeof formats)[number][0], HTMLButtonElement>();
  #editor = buildEditorFromExtensions(descriptionExtension);
  #history = createEmptyHistoryState();
  #selection: RangeSelection | null = null;
  #anchorRange: Range | null = null;
  #stopPositioning: (() => void) | null = null;
  #highlight: Highlight | null = null;
  #listeners: AbortController | null = null;
  #unregister: (() => void) | null = null;
  #value = "";
  #limit = 20_000;
  #imageCollection: string | null = null;
  #revision: string | null = null;
  #inlineImageUploads: typeof InlineImageUploads.Type = {};
  #imagePreviews = new Map<File, string>();
  #visualValue: string | null = null;
  #original = "";
  #canonical = "";
  #loading = false;
  #readOnly = false;
  #built = false;

  get value() {
    return this.#value;
  }
  set value(value: string) {
    if (value === this.#value) return;
    this.#value = value;
    if (this.#listeners) this.#receiveValue();
  }

  set label(label: string) {
    this.#body.setAttribute("aria-label", label);
  }

  set placeholder(placeholder: string) {
    this.#body.dataset.placeholder = placeholder;
  }

  set limit(limit: number) {
    this.#limit = limit;
    if (this.#listeners) this.#validate();
  }

  set imageCollection(imageCollection: string | null) {
    if (this.#imageCollection === imageCollection) return;
    this.#imageCollection = imageCollection;
    this.#visualValue = null;
    if (this.#listeners) this.#receiveValue();
  }

  set revision(revision: string | null) {
    if (this.#revision === revision) return;
    this.#revision = revision;
    if (this.#listeners)
      queueMicrotask(() => {
        if (this.#listeners && this.#revision === revision)
          this.#editor.read(() => this.#syncImages());
      });
  }

  set inlineImageUploads(uploads: typeof InlineImageUploads.Type) {
    if (uploads === this.#inlineImageUploads) return;
    this.#inlineImageUploads = uploads;
    if (this.#listeners)
      queueMicrotask(() => {
        if (this.#listeners && uploads === this.#inlineImageUploads)
          this.#editor.read(() => this.#publishDescription());
      });
  }

  get readOnly() {
    return this.#readOnly;
  }
  set readOnly(readOnly: boolean) {
    if (this.#readOnly === readOnly) return;
    this.#readOnly = readOnly;
    if (this.#built) this.#syncEditable();
  }

  connectedCallback() {
    if (this.#listeners) return;
    if (this.#built)
      this.#editor = buildEditorFromExtensions(descriptionExtension);
    else this.#build();
    this.#listeners = new AbortController();
    const { signal } = this.#listeners;
    this.#editor.setRootElement(this.#body);
    this.#unregister = mergeRegister(
      registerRichText(this.#editor),
      registerList(this.#editor),
      registerCheckList(this.#editor),
      registerHistory(this.#editor, this.#history, 450),
      registerMarkdownShortcuts(this.#editor, [
        CHECK_LIST,
        ...TRANSFORMERS.filter(
          (transformer) =>
            transformer.type !== "text-match" &&
            (transformer.type !== "text-format" ||
              transformer.format.every((format) =>
                supportedFormats.has(format),
              )),
        ),
        {
          ...LINK,
          replace: (node, match) => {
            if (taskDescriptionLink(match[2] ?? ""))
              return LINK.replace?.(node, match);
          },
        } satisfies TextMatchTransformer,
      ]),
      this.#editor.registerCommand(
        KEY_TAB_COMMAND,
        (event) => {
          const selection = $getSelection();
          if (
            !$isRangeSelection(selection) ||
            !selection.isCollapsed() ||
            event.target !== this.#body
          )
            return false;
          const item = $findMatchingParent(
            selection.anchor.getNode(),
            $isListItemNode,
          );
          if (!$isListItemNode(item)) return false;
          event.preventDefault();
          if (event.shiftKey)
            this.#editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);
          else if (item.getPreviousSibling())
            this.#editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      this.#editor.registerCommand(
        KEY_SPACE_COMMAND,
        (event) => {
          const selection = $getSelection();
          if (
            !$isRangeSelection(selection) ||
            !selection.isCollapsed() ||
            event.target !== this.#body
          )
            return false;
          const text = selection.anchor.getNode();
          if (!$isTextNode(text)) return false;
          const item = text.getParent();
          if (
            !$isListItemNode(item) ||
            item.getChildrenSize() !== 1 ||
            !$isListNode(item.getParent()) ||
            item.getParent<ListNode>()?.getListType() !== "bullet"
          )
            return false;
          const marker = text.getTextContent();
          if (
            !/^\[[ x]\]$/iu.test(marker) ||
            selection.anchor.offset !== marker.length
          )
            return false;
          event.preventDefault();
          $setListItemType(item, "check");
          item
            .clear()
            .setChecked(marker.toLowerCase() === "[x]")
            .selectStart();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      this.#editor.registerCommand(
        FORMAT_TEXT_COMMAND,
        (format) => !supportedFormats.has(format),
        COMMAND_PRIORITY_HIGH,
      ),
      this.#editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          if (!(event instanceof ClipboardEvent)) return false;
          const selection = $getSelection();
          const file = event.clipboardData?.files[0];
          if (file) {
            const imageCollection = this.#imageCollection;
            if (
              imageCollection &&
              !this.#readOnly &&
              $isRangeSelection(selection)
            ) {
              event.preventDefault();
              event.stopPropagation();
              this.#insertImage(
                imageCollection,
                file,
                selection.focus.getNode(),
              );
            }
            return true;
          }
          if (!$isRangeSelection(selection)) return false;
          event.preventDefault();
          const text = event.clipboardData?.getData("text/plain");
          if (text) {
            $addUpdateTag(PASTE_TAG);
            selection.insertRawText(text);
          }
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      this.#editor.registerCommand(
        DROP_COMMAND,
        (event) => {
          event.preventDefault();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      this.#editor.registerUpdateListener(
        ({ editorState, dirtyElements, dirtyLeaves }) => {
          if (this.#loading) return;
          editorState.read(() => {
            this.#syncSelection();
            if (dirtyElements.size || dirtyLeaves.size)
              this.#publishDescription();
          });
        },
      ),
    );
    document.addEventListener(
      "selectionchange",
      () => {
        if (this.#body.contains(document.activeElement))
          this.#editor.read(() => this.#syncSelection());
      },
      { signal },
    );
    this.addEventListener("focusout", this.#onFocusOut, { signal });
    this.addEventListener("keydown", this.#onKeyDown, {
      signal,
      capture: true,
    });
    this.#body.addEventListener("beforeinput", this.#onBeforeInput, {
      signal,
      capture: true,
    });
    this.closest("form")?.addEventListener("submit", () => this.#flush(), {
      signal,
      capture: true,
    });
    this.#visualValue = null;
    this.#receiveValue();
  }

  disconnectedCallback() {
    this.#listeners?.abort();
    this.#listeners = null;
    this.#unregister?.();
    this.#unregister = null;
    this.#editor.dispose();
    this.#history = createEmptyHistoryState();
    this.#selection = null;
    this.#closeMenu();
    this.#closeFloating();
    for (const url of this.#imagePreviews.values()) URL.revokeObjectURL(url);
    this.#imagePreviews.clear();
    this.#imageInsertionKey = null;
  }

  #build() {
    this.#built = true;
    this.classList.add("task-description");

    this.#floating.className = `task-description-floating ${toolbarClassName("compact-surface")}`;
    this.#floating.dataset.slot = "toolbar";
    this.#floating.setAttribute("popover", "manual");
    this.#formatting.className = "task-description-formatting";
    this.#formatting.setAttribute("role", "toolbar");
    this.#formatting.setAttribute("aria-label", "Description formatting");
    for (const [format, content, label] of formats) {
      const button = makeButton(
        typeof content === "string" ? content : makeOutlineIcon(content),
        label,
        () => this.#toggleFormat(format),
      );
      button.className = compactToggleClassName;
      button.dataset.slot = "toggle";
      button.dataset.format = format;
      button.setAttribute("aria-pressed", "false");
      this.#formatButtons.set(format, button);
      this.#formatting.append(button);
    }
    this.#linkButton.className = compactToggleClassName;
    this.#linkButton.dataset.slot = "button";
    this.#linkButton.setAttribute("aria-keyshortcuts", "Control+k Meta+k");
    this.#formatting.append(this.#linkButton);
    this.#setToolbarTabStop(
      this.#formatting.firstElementChild as HTMLButtonElement,
    );
    this.#formatting.addEventListener("pointerdown", (event) =>
      event.preventDefault(),
    );
    this.#formatting.addEventListener("focusin", (event) => {
      if (event.target instanceof HTMLButtonElement)
        this.#setToolbarTabStop(event.target);
    });

    this.#menu.className = "task-description-panel";
    this.#menu.hidden = true;
    this.#options.id = `${this.#id}-blocks`;
    this.#options.setAttribute("role", "listbox");
    this.#options.setAttribute("aria-label", "Insert block");
    this.#menu.append(this.#options);

    this.#link.className = "task-description-link";
    this.#link.hidden = true;
    this.#url.type = "text";
    this.#url.className = inputClassName;
    this.#url.dataset.slot = "input";
    this.#url.inputMode = "url";
    this.#url.placeholder = "https://…";
    this.#url.setAttribute("aria-label", "Link URL");
    this.#url.addEventListener("input", () => this.#setLinkError(""));
    this.#linkError.id = `${this.#id}-link-error`;
    this.#linkError.setAttribute("role", "status");
    const applyLink = makeButton("Apply", "Apply link", () =>
      this.#applyLink(),
    );
    for (const button of [applyLink, this.#removeLink]) {
      button.className = buttonClassName({ variant: "ghost", size: "sm" });
      button.dataset.slot = "button";
    }
    this.#link.append(this.#url, applyLink, this.#removeLink, this.#linkError);
    this.#floating.append(this.#formatting, this.#menu, this.#link);

    this.#body.className = `task-description-body ${documentTypography.body}`;
    this.#body.setAttribute("role", "textbox");
    this.#body.setAttribute("aria-multiline", "true");
    this.#imageInput.type = "file";
    this.#imageInput.accept = "image/png,image/jpeg,.png,.jpg,.jpeg";
    this.#imageInput.hidden = true;
    this.#imageInput.addEventListener("cancel", () => {
      this.#imageInsertionKey = null;
    });
    this.#imageInput.addEventListener("change", () => {
      const file = this.#imageInput.files?.[0];
      const key = this.#imageInsertionKey;
      const imageCollection = this.#imageCollection;
      this.#imageInput.value = "";
      this.#imageInsertionKey = null;
      if (!file || !imageCollection || !key) return;
      this.#edit(() =>
        this.#insertImage(imageCollection, file, $getNodeByKey(key)),
      );
    });
    // Use the visible mark as the pointer target. Lexical handles keyboard
    // interaction, and its touch pointerup must not also toggle on this click.
    for (const type of ["pointerdown", "pointerup"] as const) {
      this.#body.addEventListener(
        type,
        (event) => {
          if (!this.#checkboxMark(event)) return;
          event.preventDefault();
          event.stopPropagation();
        },
        { capture: true },
      );
    }
    this.#body.addEventListener(
      "click",
      (event) => {
        const removeImage =
          event.target instanceof Element &&
          event.target.closest("button[data-remove-image]");
        if (removeImage) {
          event.preventDefault();
          event.stopPropagation();
          this.#edit(() => {
            const node = $getNearestNodeFromDOMNode(removeImage);
            if (node instanceof MarkdownImageNode) node.remove();
          });
          return;
        }
        const mark = this.#checkboxMark(event);
        if (mark) {
          event.preventDefault();
          event.stopPropagation();
          mark.focus();
          this.#editor.update(() => {
            const item = $getNearestNodeFromDOMNode(mark);
            if ($isListItemNode(item)) item.toggleChecked();
          });
        } else if (
          event.target instanceof Element &&
          event.target.closest("a")
        ) {
          event.preventDefault();
        }
      },
      { capture: true },
    );

    this.#error.className = "task-description-error";
    this.#error.id = `${this.#id}-error`;
    this.#error.setAttribute("role", "status");
    this.append(this.#body, this.#floating, this.#imageInput, this.#error);
  }

  #receiveValue() {
    this.#closeMenu();
    this.#closeFloating();
    this.#loadVisual();
    this.#syncEditable();
    this.#validate();
  }

  #checkboxMark(event: MouseEvent) {
    const item = event.target;
    if (
      this.#readOnly ||
      !(item instanceof HTMLLIElement) ||
      item.getAttribute("role") !== "checkbox"
    )
      return null;
    const bounds = item.getBoundingClientRect();
    const style = getComputedStyle(item, "::before");
    const width = parseFloat(style.width);
    const offset =
      style.direction === "rtl"
        ? event.clientX - bounds.right
        : bounds.left - event.clientX;
    return offset >= 0 && offset <= width ? item : null;
  }

  #loadVisual() {
    if (this.#value === this.#visualValue) return;
    const blocks = parseDescription(
      this.#value,
      this.#imageCollection ?? undefined,
    );
    this.#loading = true;
    this.#selection = null;
    this.#editor.update(
      () => {
        $loadDescription(blocks);
        $setSelection(null);
      },
      { discrete: true, tag: [HISTORIC_TAG, SKIP_DOM_SELECTION_TAG] },
    );
    this.#editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
    this.#original = this.#value;
    this.#visualValue = this.#value;
    this.#canonical = this.#editor.read(() => {
      this.#syncImages();
      return $serializeDescription();
    });
    this.#history.current = {
      editor: this.#editor,
      editorState: this.#editor.getEditorState(),
    };
    this.#loading = false;
  }

  #syncEditable() {
    const editable = !this.#readOnly;
    this.#editor.setEditable(editable);
    this.#body.contentEditable = String(editable);
    this.#body.setAttribute("aria-readonly", String(this.#readOnly));
    if (this.#readOnly) {
      this.#closeMenu();
      this.#closeFloating();
    }
  }

  #validate() {
    const excess = this.#value.length - this.#limit;
    this.#error.hidden = excess <= 0;
    this.#error.textContent =
      excess > 0
        ? `Remove ${excess.toLocaleString()} ${excess === 1 ? "character" : "characters"} to save. The Markdown limit is ${this.#limit.toLocaleString()} characters.`
        : "";
    if (excess > 0) {
      this.#body.setAttribute("aria-invalid", "true");
      this.#body.setAttribute("aria-describedby", this.#error.id);
    } else {
      this.#body.removeAttribute("aria-invalid");
      this.#body.removeAttribute("aria-describedby");
    }
  }

  #changed(markdown: string) {
    if (markdown === this.#value) return;
    this.#value = markdown;
    this.#validate();
    this.dispatchEvent(
      new CustomEvent("description-edited", {
        detail: markdown,
        bubbles: true,
      }),
    );
  }

  #insertImage(
    imageCollection: string,
    file: File,
    anchor: LexicalNode | null,
  ) {
    const id = crypto.randomUUID();
    const image = $createMarkdownImage({
      url: `${imageCollection}/${id}`,
      alt: file.name || "Image",
      title: null,
      uploadId: id,
    });
    const block = anchor?.isAttached() ? anchor.getTopLevelElement() : null;
    $addUpdateTag(PASTE_TAG);
    if ($isParagraphNode(block) && block.isEmpty()) block.replace(image);
    else if (block) block.insertAfter(image);
    else $getRoot().append(image);
    const next = image.getNextSibling();
    if ($isParagraphNode(next)) next.selectStart();
    else image.insertAfter($createTrailingParagraph()).selectStart();
    this.dispatchEvent(
      new CustomEvent("description-image-pasted", {
        detail: { id, file },
        bubbles: true,
      }),
    );
  }

  #syncImages() {
    for (const [file, url] of this.#imagePreviews) {
      if (Object.values(this.#inlineImageUploads).includes(file)) continue;
      URL.revokeObjectURL(url);
      this.#imagePreviews.delete(file);
    }
    for (const node of $getRoot().getChildren()) {
      if (!(node instanceof MarkdownImageNode)) continue;
      const { url, uploadId } = node.getImage();
      const id =
        uploadId ??
        (this.#imageCollection && markdownImageId(this.#imageCollection, url));
      const outcome = id ? this.#inlineImageUploads[id] : undefined;
      const figure = this.#editor.getElementByKey(node.getKey());
      const image = figure?.querySelector("img");
      const status = figure?.querySelector("figcaption");
      if (!figure || !image || !status) continue;
      if (!figure.querySelector("button[data-remove-image]")) {
        const remove = makeButton(
          makeOutlineIcon(trashIconPaths),
          "Remove image",
        );
        remove.className = buttonClassName({
          variant: "outline",
          size: "icon-sm",
        });
        remove.dataset.slot = "button";
        remove.dataset.removeImage = "";
        figure.append(remove);
        image.addEventListener("error", () => this.#retryImage(image));
      }
      const src =
        outcome instanceof File
          ? this.#imagePreview(outcome)
          : outcome === true || (!uploadId && outcome === undefined)
            ? url
            : null;
      image.hidden = src === null;
      if (!src) {
        delete image.dataset.imageSource;
        image.removeAttribute("src");
      } else if (image.dataset.imageSource !== src) {
        image.dataset.imageSource = src;
        image.dataset.revision = this.#revision ?? "";
        image.src = src;
      } else if (image.complete && image.naturalWidth === 0) {
        this.#retryImage(image);
      }
      const message =
        typeof outcome === "string"
          ? outcome
          : !src || outcome instanceof File
            ? "Uploading image…"
            : "";
      status.hidden = message === "";
      if (status.textContent !== message) status.textContent = message;
    }
  }

  #retryImage(image: HTMLImageElement) {
    const src = image.dataset.imageSource;
    const revision = this.#revision;
    if (
      !src?.startsWith("/") ||
      !revision ||
      image.dataset.revision === revision
    )
      return;
    // Undo can render before autosave has restored access to the attachment.
    image.dataset.revision = revision;
    image.src = `${src}?revision=${revision}`;
  }

  #imagePreview(file: File) {
    const preview = this.#imagePreviews.get(file) ?? URL.createObjectURL(file);
    this.#imagePreviews.set(file, preview);
    return preview;
  }

  #publishDescription() {
    this.#syncImages();
    if (this.#readOnly) return;
    const canonical = $serializeDescription((id) => {
      const outcome = this.#inlineImageUploads[id];
      return outcome === true || outcome instanceof File;
    });
    const markdown = canonical === this.#canonical ? this.#original : canonical;
    this.#visualValue = markdown;
    this.#changed(markdown);
  }

  #flush() {
    this.#editor.read(() => {});
  }

  #onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && this.contains(next)) return;
    this.#flush();
    this.#closeMenu();
    this.#closeFloating();
    this.dispatchEvent(
      new CustomEvent("description-blurred", {
        detail: this.#value,
        bubbles: true,
      }),
    );
  };

  #edit(run: () => void) {
    if (this.#readOnly) return;
    const selection = this.#selection;
    this.#body.focus({ preventScroll: true });
    this.#editor.update(
      () => {
        if (selection) $setSelection(selection.clone());
        else $getRoot().selectEnd();
        run();
      },
      { discrete: true },
    );
  }

  #onBeforeInput = (event: InputEvent) => {
    if (
      this.#readOnly ||
      event.isComposing ||
      event.inputType !== "insertText" ||
      event.data !== "/"
    )
      return;
    this.#editor.read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
      const block = $selectionBlock(selection);
      if ($isElementNode(block) && !$isCodeNode(block) && block.isEmpty())
        this.#slashBlockKey = block.getKey();
    });
  };

  #syncSlashMenu(selection: RangeSelection | null) {
    const key = this.#slashBlockKey;
    if (key === null) return false;
    const block = selection?.isCollapsed() ? $selectionBlock(selection) : null;
    const element =
      block?.getKey() === key && this.#editor.getElementByKey(key);
    const text = block?.getTextContent();
    if (!element || !text?.startsWith("/") || text.includes("\n")) {
      this.#closeMenu();
      return false;
    }

    if (this.#menu.hidden) {
      this.#formatting.hidden = true;
      this.#menu.hidden = false;
      this.#body.setAttribute("aria-controls", this.#options.id);
      this.#body.setAttribute("aria-autocomplete", "list");
    }
    const query = text.slice(1).trim().toLowerCase();
    if (query !== this.#slashQuery) {
      this.#slashQuery = query;
      this.#renderOptions(query);
    }
    const range = document.createRange();
    range.selectNodeContents(element);
    this.#anchorFloating(range);
    return true;
  }

  #renderOptions(query: string) {
    this.#matches = blockChoices.filter(({ label, keywords }) =>
      `${label.toLowerCase()} ${keywords}`.includes(query),
    );
    this.#options.replaceChildren();
    for (const [index, choice] of this.#matches.entries()) {
      const option = makeButton(choice.label, choice.label, () =>
        this.#applyBlock(index),
      );
      option.prepend(makeOutlineIcon(choice.iconPaths));
      option.id = `${this.#options.id}-${index}`;
      option.setAttribute("role", "option");
      option.tabIndex = -1;
      option.addEventListener("pointerdown", (event) => event.preventDefault());
      this.#options.append(option);
    }
    if (!this.#matches.length) {
      const status = document.createElement("div");
      status.setAttribute("role", "status");
      status.textContent = "No matching blocks";
      this.#options.append(status);
    }
    this.#selectOption(0);
  }

  #selectOption(index: number) {
    const count = this.#matches.length;
    this.#activeOption = count ? (index + count) % count : 0;
    this.#options.querySelectorAll("[role=option]").forEach((option, i) => {
      option.setAttribute("aria-selected", String(i === this.#activeOption));
    });
    const active = count ? this.#options.children[this.#activeOption] : null;
    if (active) {
      this.#body.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
    } else this.#body.removeAttribute("aria-activedescendant");
  }

  #applyBlock(index: number) {
    const choice = this.#matches[index];
    const key = this.#slashBlockKey;
    if (!choice || key === null) return;
    this.#closeMenu();
    this.#edit(() => {
      const block = $getNodeByKey(key);
      if (!$isElementNode(block)) return;
      block.clear().selectStart();
      choice.apply?.();
    });
    if (!choice.apply && this.#imageCollection) {
      this.#imageInsertionKey = key;
      this.#imageInput.click();
    }
  }

  #syncSelection() {
    if (!this.#body.contains(document.activeElement)) return;
    const selection = $getSelection();
    this.#selection = $isRangeSelection(selection) ? selection.clone() : null;
    if (this.#readOnly || !this.#link.hidden) return;
    if (this.#syncSlashMenu(this.#selection)) return;

    const domSelection = document.getSelection();
    const range = domSelection?.rangeCount ? domSelection.getRangeAt(0) : null;
    if (
      !$isRangeSelection(selection) ||
      selection.isCollapsed() ||
      !range ||
      !this.#body.contains(range.commonAncestorContainer) ||
      !range.toString()
    ) {
      this.#closeFloating();
      return;
    }
    const nodes = $selectedTextNodes(selection);
    if (!nodes.length) {
      this.#closeFloating();
      return;
    }
    for (const [format, button] of this.#formatButtons)
      button.setAttribute(
        "aria-pressed",
        String(nodes.every((node) => node.hasFormat(format))),
      );

    this.#anchorFloating(range.cloneRange());
  }

  #anchorFloating(range: Range) {
    this.#anchorRange = range;
    if (this.#stopPositioning) {
      this.#positionFloating();
      return;
    }
    this.#floating.style.visibility = "hidden";
    this.#floating.showPopover();
    this.#stopPositioning = autoUpdate(
      this.#reference,
      this.#floating,
      this.#positionFloating,
    );
  }

  #reference: VirtualElement = {
    contextElement: this.#body,
    getBoundingClientRect: () =>
      this.#anchorRange?.getBoundingClientRect() ?? new DOMRect(),
    getClientRects: () => this.#anchorRange?.getClientRects() ?? [],
  };

  #positionFloating = async () => {
    const range = this.#anchorRange;
    const { x, y, middlewareData } = await computePosition(
      this.#reference,
      this.#floating,
      {
        strategy: "fixed",
        placement: this.#menu.hidden ? "bottom" : "bottom-start",
        middleware: [
          inline(),
          offset(8),
          flip({ padding: 8 }),
          shift({ padding: 8, crossAxis: true }),
          hide(),
        ],
      },
    );
    if (!range || range !== this.#anchorRange) return;
    this.#floating.style.left = `${x}px`;
    this.#floating.style.top = `${y}px`;
    this.#floating.style.visibility = middlewareData.hide?.referenceHidden
      ? "hidden"
      : "";
  };

  #closeFloating() {
    this.#stopPositioning?.();
    this.#stopPositioning = null;
    this.#anchorRange = null;
    this.#resetLink();
    this.#floating.hidePopover();
  }

  #setToolbarTabStop(active: HTMLButtonElement) {
    for (const button of this.#formatting.querySelectorAll("button"))
      button.tabIndex = button === active ? 0 : -1;
  }

  #toggleFormat(format: (typeof formats)[number][0]) {
    this.#edit(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || selection.isCollapsed()) return;
      const nodes = $selectedTextNodes(selection);
      if (nodes.length)
        selection.formatText(
          format,
          nodes.every((node) => node.hasFormat(format))
            ? 0
            : TEXT_TYPE_TO_FORMAT[format],
        );
    });
  }

  #openLink() {
    this.#flush();
    const selection = this.#selection;
    const range = this.#anchorRange;
    if (!selection || !range || this.#readOnly) return;
    const url = this.#editor.read(() => $selectedLink(selection)?.getURL());
    this.#url.value = url ?? "";
    this.#removeLink.hidden = url === undefined;
    this.#setLinkError("");
    this.#link.hidden = false;
    this.#url.focus();
    this.#formatting.hidden = true;
    this.#url.select();
    if (CSS.highlights) {
      this.#highlight = new Highlight(range);
      CSS.highlights.set("task-description-selection", this.#highlight);
    }
  }

  #applyLink(remove = false) {
    const url = remove ? null : taskDescriptionLink(this.#url.value);
    if (!remove && !url) {
      this.#setLinkError("Enter a valid HTTP, HTTPS, mailto or relative link.");
      this.#url.focus();
      return;
    }
    this.#finishLink(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      const link = $selectedLink(selection);
      if (url && link) link.setURL(url);
      else if (link) {
        for (const child of link.getChildren()) link.insertBefore(child);
        link.remove();
      } else $toggleLink(url);
    });
  }

  #setLinkError(message: string) {
    this.#linkError.textContent = message;
    this.#linkError.hidden = !message;
    if (message) {
      this.#url.setAttribute("aria-invalid", "true");
      this.#url.setAttribute("aria-describedby", this.#linkError.id);
    } else {
      this.#url.removeAttribute("aria-invalid");
      this.#url.removeAttribute("aria-describedby");
    }
  }

  #finishLink(run: () => void) {
    this.#edit(run);
    this.#resetLink();
    this.#editor.read(() => this.#syncSelection());
  }

  #resetLink() {
    this.#formatting.hidden = false;
    this.#link.hidden = true;
    if (
      this.#highlight &&
      CSS.highlights.get("task-description-selection") === this.#highlight
    )
      CSS.highlights.delete("task-description-selection");
    this.#highlight = null;
  }

  #closeMenu() {
    this.#slashBlockKey = null;
    this.#slashQuery = null;
    if (this.#menu.hidden) return;
    this.#menu.hidden = true;
    this.#body.removeAttribute("aria-controls");
    this.#body.removeAttribute("aria-autocomplete");
    this.#body.removeAttribute("aria-activedescendant");
    this.#closeFloating();
  }

  #onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || this.#readOnly) return;
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "Escape" && (!this.#menu.hidden || !this.#link.hidden)) {
      consume();
      if (!this.#link.hidden) this.#finishLink(() => {});
      else this.#closeMenu();
    } else if (
      !this.#menu.hidden &&
      this.#matches.length &&
      event.target === this.#body &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      ["ArrowDown", "ArrowUp", "Enter"].includes(event.key)
    ) {
      consume();
      if (event.key === "Enter") this.#applyBlock(this.#activeOption);
      else
        this.#selectOption(
          this.#activeOption + (event.key === "ArrowDown" ? 1 : -1),
        );
    } else if (event.target === this.#url && event.key === "Enter") {
      consume();
      this.#applyLink();
    } else if (
      event.target instanceof HTMLButtonElement &&
      this.#formatting.contains(event.target) &&
      ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    ) {
      consume();
      const buttons = [...this.#formatting.querySelectorAll("button")];
      const index = buttons.indexOf(event.target);
      const direction =
        getComputedStyle(this.#formatting).direction === "rtl" ? -1 : 1;
      const step = event.key === "ArrowRight" ? direction : -direction;
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (index + step + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (
      event.target instanceof Node &&
      this.#body.contains(event.target)
    ) {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "k" &&
        this.#menu.hidden &&
        this.#anchorRange
      ) {
        consume();
        this.#openLink();
      }
    }
  };
}

customElements.define(markdownEditor.tag, MarkdownEditor);
