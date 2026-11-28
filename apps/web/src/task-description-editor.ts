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
  inputClassName,
  toolbarClassName,
} from "@orumai/ui";
import {
  $addUpdateTag,
  $createParagraphNode,
  $findMatchingParent,
  $getNearestNodeFromDOMNode,
  $getRoot,
  $getSelection,
  $isElementNode,
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
  type RangeSelection,
  type TextFormatType,
} from "lexical";
import { taskDescriptionEditor } from "./task-description-editor-contract.ts";
import {
  $loadDescription,
  $serializeDescription,
  parseDescription,
  PreservedMarkdownNode,
  taskDescriptionLink,
} from "./task-description-markdown.ts";
import { taskDescriptionLimit } from "./tasks-contract.ts";

const setBlock = (create: () => ElementNode) => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  $setBlocksType(selection, create);
};

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

const blockChoices = [
  {
    label: "Paragraph",
    keywords: "text",
    apply: () => setBlock($createParagraphNode),
  },
  ...[1, 2, 3].map((level) => ({
    label: `Heading ${level}`,
    keywords: "# title",
    apply: () =>
      setBlock(() => $createHeadingNode(`h${level}` as HeadingTagType)),
  })),
  {
    label: "Bulleted list",
    keywords: "- * unordered",
    apply: () => $setListType("bullet"),
  },
  {
    label: "Numbered list",
    keywords: "1. ordered",
    apply: () => $setListType("number"),
  },
  {
    label: "Checklist",
    keywords: "[] checkbox to-do task list",
    apply: () => $setListType("check"),
  },
  {
    label: "Block quote",
    keywords: "> quotation",
    apply: () => setBlock($createQuoteNode),
  },
  {
    label: "Code block",
    keywords: "``` fenced",
    apply: () => setBlock($createCodeNode),
  },
];

const formats = [
  ["bold", "B", "Bold"],
  ["italic", "I", "Italic"],
] as const;
const supportedFormats = new Set<TextFormatType>(["bold", "italic", "code"]);

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

const makeButton = (text: string, label: string, run: () => void) => {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", run);
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
  ],
  theme: {
    code: "task-description-code",
    text: {
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

export class TaskDescriptionEditor extends HTMLElement {
  #id = `task-description-${++nextEditorId}`;
  #body = document.createElement("div");
  #blockTools = document.createElement("div");
  #floating = document.createElement("div");
  #formatting = document.createElement("div");
  #insert = makeButton("+", "Insert block", () =>
    this.#menu.hidden ? this.#openMenu() : this.#closeMenu(true),
  );
  #menu = document.createElement("div");
  #search = document.createElement("input");
  #options = document.createElement("div");
  #matches = blockChoices;
  #activeOption = 0;
  #link = document.createElement("div");
  #url = document.createElement("input");
  #linkError = document.createElement("span");
  #linkButton = makeButton("Link", "Add or edit link", () => this.#openLink());
  #removeLink = makeButton("Remove", "Remove link", () =>
    this.#applyLink(true),
  );
  #error = document.createElement("p");
  #formatButtons = new Map<(typeof formats)[number][0], HTMLButtonElement>();
  #editor = buildEditorFromExtensions(descriptionExtension);
  #history = createEmptyHistoryState();
  #selection: RangeSelection | null = null;
  #selectionRange: Range | null = null;
  #stopPositioning: (() => void) | null = null;
  #highlight: Highlight | null = null;
  #listeners: AbortController | null = null;
  #unregister: (() => void) | null = null;
  #value = "";
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
          // The enclosing task surface owns file pastes. Keep the event bubbling.
          if (event.clipboardData?.files.length) return true;
          const selection = $getSelection();
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
            if (dirtyElements.size || dirtyLeaves.size) {
              const canonical = $serializeDescription();
              const markdown =
                canonical === this.#canonical ? this.#original : canonical;
              this.#visualValue = markdown;
              this.#changed(markdown);
            }
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
    this.#closeMenu(false);
    this.#closeFormatting();
  }

  #build() {
    this.#built = true;
    this.classList.add("task-description");
    this.#blockTools.className = "task-description-block-tools";
    this.#insert.setAttribute("aria-expanded", "false");
    this.#insert.setAttribute("aria-controls", `${this.#id}-menu`);
    this.#blockTools.append(this.#insert);

    this.#floating.className = `task-description-floating ${toolbarClassName("compact-surface")}`;
    this.#floating.dataset.slot = "toolbar";
    this.#floating.setAttribute("popover", "manual");
    this.#formatting.className = "task-description-formatting";
    this.#formatting.setAttribute("role", "toolbar");
    this.#formatting.setAttribute("aria-label", "Description formatting");
    for (const [format, text, label] of formats) {
      const button = makeButton(text, label, () => this.#toggleFormat(format));
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

    this.#menu.id = `${this.#id}-menu`;
    this.#menu.className = "task-description-panel";
    this.#menu.hidden = true;
    this.#search.type = "text";
    this.#search.placeholder = "Search blocks…";
    this.#search.setAttribute("aria-label", "Search blocks");
    this.#search.setAttribute("role", "combobox");
    this.#search.setAttribute("aria-expanded", "true");
    this.#search.setAttribute("aria-autocomplete", "list");
    this.#options.id = `${this.#id}-blocks`;
    this.#options.setAttribute("role", "listbox");
    this.#options.setAttribute("aria-label", "Blocks");
    this.#search.setAttribute("aria-controls", this.#options.id);
    this.#search.addEventListener("input", () => this.#renderOptions());
    this.#menu.append(this.#search, this.#options);

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
    this.#floating.append(this.#formatting, this.#link);

    this.#body.className = "task-description-body";
    this.#body.setAttribute("role", "textbox");
    this.#body.setAttribute("aria-label", "Description");
    this.#body.setAttribute("aria-multiline", "true");
    this.#body.dataset.placeholder = "Add a description…";
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
    this.append(
      this.#blockTools,
      this.#menu,
      this.#body,
      this.#floating,
      this.#error,
    );
  }

  #receiveValue() {
    this.#closeMenu(false);
    this.#closeFormatting();
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
    const blocks = parseDescription(this.#value);
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
    this.#canonical = this.#editor.read($serializeDescription);
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
    this.#insert.disabled = this.#readOnly;
    if (this.#readOnly) {
      this.#closeMenu(false);
      this.#closeFormatting();
    }
  }

  #validate() {
    const excess = this.#value.length - taskDescriptionLimit;
    this.#error.hidden = excess <= 0;
    this.#error.textContent =
      excess > 0
        ? `Remove ${excess.toLocaleString()} ${excess === 1 ? "character" : "characters"} to save. The Markdown limit is 20,000 characters.`
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

  #flush() {
    this.#editor.read(() => {});
  }

  #onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && this.contains(next)) {
      if (!this.#body.contains(next) && !this.#floating.contains(next))
        this.#closeFormatting();
      return;
    }
    this.#flush();
    this.#closeMenu(false);
    this.#closeFormatting();
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

  #openMenu() {
    if (this.#readOnly) return;
    this.#flush();
    this.#closeFormatting();
    this.#menu.hidden = false;
    this.#insert.setAttribute("aria-expanded", "true");
    this.#search.value = "";
    this.#renderOptions();
    this.#search.focus();
  }

  #renderOptions() {
    const query = this.#search.value.trim().toLowerCase();
    this.#matches = blockChoices.filter(({ label, keywords }) =>
      `${label.toLowerCase()} ${keywords}`.includes(query),
    );
    this.#options.replaceChildren();
    for (const [index, choice] of this.#matches.entries()) {
      const option = makeButton(choice.label, choice.label, () =>
        this.#applyBlock(index),
      );
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
      this.#search.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
    } else this.#search.removeAttribute("aria-activedescendant");
  }

  #applyBlock(index: number) {
    const choice = this.#matches[index];
    if (choice) {
      this.#edit(choice.apply);
      this.#closeMenu(false);
    }
  }

  #syncSelection() {
    if (!this.#body.contains(document.activeElement)) return;
    const selection = $getSelection();
    this.#selection = $isRangeSelection(selection) ? selection.clone() : null;
    if (this.#readOnly || !this.#menu.hidden || !this.#link.hidden) return;

    const domSelection = document.getSelection();
    const range = domSelection?.rangeCount ? domSelection.getRangeAt(0) : null;
    if (
      !$isRangeSelection(selection) ||
      selection.isCollapsed() ||
      !range ||
      !this.#body.contains(range.commonAncestorContainer) ||
      !range.toString()
    ) {
      this.#closeFormatting();
      return;
    }
    const nodes = $selectedTextNodes(selection);
    if (!nodes.length) {
      this.#closeFormatting();
      return;
    }
    for (const [format, button] of this.#formatButtons)
      button.setAttribute(
        "aria-pressed",
        String(nodes.every((node) => node.hasFormat(format))),
      );

    this.#selectionRange = range.cloneRange();
    if (this.#stopPositioning) {
      this.#positionToolbar();
      return;
    }
    this.#floating.style.visibility = "hidden";
    this.#floating.showPopover();
    this.#stopPositioning = autoUpdate(
      this.#reference,
      this.#floating,
      this.#positionToolbar,
    );
  }

  #reference: VirtualElement = {
    contextElement: this.#body,
    getBoundingClientRect: () =>
      this.#selectionRange?.getBoundingClientRect() ?? new DOMRect(),
    getClientRects: () => this.#selectionRange?.getClientRects() ?? [],
  };

  #positionToolbar = async () => {
    const range = this.#selectionRange;
    const { x, y, middlewareData } = await computePosition(
      this.#reference,
      this.#floating,
      {
        strategy: "fixed",
        placement: "top",
        middleware: [
          inline(),
          offset(8),
          flip({ padding: 8 }),
          shift({ padding: 8, crossAxis: true }),
          hide(),
        ],
      },
    );
    if (!range || range !== this.#selectionRange) return;
    this.#floating.style.left = `${x}px`;
    this.#floating.style.top = `${y}px`;
    this.#floating.style.visibility = middlewareData.hide?.referenceHidden
      ? "hidden"
      : "";
  };

  #closeFormatting() {
    this.#stopPositioning?.();
    this.#stopPositioning = null;
    this.#selectionRange = null;
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
    const range = this.#selectionRange;
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

  #closeMenu(restoreFocus: boolean) {
    if (restoreFocus) this.#edit(() => {});
    this.#menu.hidden = true;
    this.#insert.setAttribute("aria-expanded", "false");
    if (restoreFocus) this.#editor.read(() => this.#syncSelection());
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
      else this.#closeMenu(true);
    } else if (
      event.target === this.#search &&
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
        this.#selectionRange
      ) {
        consume();
        this.#openLink();
      } else if (
        event.key === "/" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        this.#editor.read(() => {
          const selection = $getSelection();
          if (
            !$isRangeSelection(selection) ||
            !selection.isCollapsed() ||
            selection.anchor.offset
          )
            return false;
          const anchor = selection.anchor.getNode();
          const block = $findMatchingParent(
            anchor,
            (node) => $isElementNode(node) && !node.isInline(),
          );
          return (
            $isElementNode(block) &&
            !$isCodeNode(block) &&
            (anchor === block || block.getFirstDescendant() === anchor)
          );
        })
      ) {
        consume();
        this.#openMenu();
      }
    }
  };
}

customElements.define(taskDescriptionEditor.tag, TaskDescriptionEditor);
