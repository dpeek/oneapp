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
  ["code", "<>", "Inline code"],
] as const;

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
  nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode],
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
  #source = document.createElement("textarea");
  #sourceField = document.createElement("span");
  #toolbar = document.createElement("div");
  #visualTools = document.createElement("div");
  #insert = makeButton("+", "Insert block", () =>
    this.#menu.hidden ? this.#openMenu() : this.#closePanel(true),
  );
  #mode = makeButton("Markdown", "Edit Markdown source", () =>
    this.#toggleSource(),
  );
  #menu = document.createElement("div");
  #search = document.createElement("input");
  #options = document.createElement("div");
  #matches = blockChoices;
  #activeOption = 0;
  #link = document.createElement("div");
  #url = document.createElement("input");
  #linkError = document.createElement("span");
  #sourceNote = document.createElement("p");
  #error = document.createElement("p");
  #formatButtons = new Map<TextFormatType, HTMLButtonElement>();
  #editor = buildEditorFromExtensions(descriptionExtension);
  #history = createEmptyHistoryState();
  #selection: RangeSelection | null = null;
  #listeners: AbortController | null = null;
  #unregister: (() => void) | null = null;
  #value = "";
  #visualValue: string | null = null;
  #original = "";
  #canonical = "";
  #loading = false;
  #sourceMode = false;
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
    if (this.#built) this.#syncMode();
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
                this.#formatButtons.has(format),
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
          if (!$isRangeSelection(selection) || event.target !== this.#body)
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
        (format) => !this.#formatButtons.has(format),
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
          if (this.#loading || this.#sourceMode) return;
          editorState.read(() => {
            const selection = $getSelection();
            if (
              $isRangeSelection(selection) &&
              this.#body.contains(document.activeElement)
            ) {
              this.#selection = selection.clone();
              for (const [format, button] of this.#formatButtons)
                button.setAttribute(
                  "aria-pressed",
                  String(selection.hasFormat(format)),
                );
            }
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
    this.#closePanel(false);
  }

  #build() {
    this.#built = true;
    this.classList.add("task-description");
    this.#toolbar.className = "task-description-toolbar";
    this.#visualTools.className = "task-description-tools";
    this.#toolbar.setAttribute("role", "group");
    this.#toolbar.setAttribute("aria-label", "Description formatting");
    this.#insert.setAttribute("aria-expanded", "false");
    this.#insert.setAttribute("aria-controls", `${this.#id}-menu`);
    this.#visualTools.append(this.#insert);
    for (const [format, text, label] of formats) {
      const button = makeButton(text, label, () =>
        this.#edit(() => {
          this.#editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
        }),
      );
      button.dataset.format = format;
      button.setAttribute("aria-pressed", "false");
      this.#formatButtons.set(format, button);
      this.#visualTools.append(button);
    }
    this.#visualTools.append(
      makeButton("Link", "Add or edit link", () => this.#openLink()),
    );
    this.#toolbar.append(this.#visualTools, this.#mode);

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

    this.#link.className = "task-description-panel task-description-link";
    this.#link.hidden = true;
    this.#url.type = "text";
    this.#url.inputMode = "url";
    this.#url.placeholder = "https://…";
    this.#url.setAttribute("aria-label", "Link URL");
    this.#linkError.setAttribute("role", "status");
    this.#link.append(
      this.#url,
      makeButton("Apply", "Apply link", () => this.#applyLink()),
      makeButton("Remove", "Remove link", () => this.#applyLink(true)),
      makeButton("Cancel", "Cancel link", () => this.#closePanel(true)),
      this.#linkError,
    );

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

    this.#sourceField.className = "task-document-input task-description-source";
    this.#source.rows = 1;
    this.#source.setAttribute("aria-label", "Description (Markdown)");
    this.#source.placeholder = "Add a description…";
    this.#source.addEventListener("input", () =>
      this.#changed(this.#source.value),
    );
    this.#sourceField.append(this.#source);
    this.#sourceNote.className = "task-description-note";
    this.#sourceNote.setAttribute("role", "status");
    this.#sourceNote.hidden = true;
    this.#error.className = "task-description-error";
    this.#error.id = `${this.#id}-error`;
    this.#error.setAttribute("role", "status");
    this.append(
      this.#toolbar,
      this.#menu,
      this.#link,
      this.#body,
      this.#sourceNote,
      this.#sourceField,
      this.#error,
    );
  }

  #receiveValue() {
    this.#closePanel(false);
    if (!this.#sourceMode && !this.#loadVisual()) this.#sourceMode = true;
    this.#syncMode();
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
    if (this.#value === this.#visualValue) return true;
    const blocks = parseDescription(this.#value);
    if (!blocks) {
      this.#sourceNote.textContent =
        "This description uses Markdown that needs the source editor. Edit it here to preserve its formatting.";
      this.#sourceNote.hidden = false;
      return false;
    }
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
    this.#sourceNote.hidden = true;
    return true;
  }

  #toggleSource() {
    this.#flush();
    this.#closePanel(false);
    if (this.#sourceMode && !this.#loadVisual()) {
      this.#source.focus();
      return;
    }
    this.#sourceMode = !this.#sourceMode;
    this.#syncMode();
    if (this.#sourceMode) this.#source.focus();
    else this.#edit(() => {});
  }

  #syncMode() {
    const editable = !this.#sourceMode && !this.#readOnly;
    this.#editor.setEditable(editable);
    this.#body.contentEditable = String(editable);
    this.#body.setAttribute("aria-readonly", String(this.#readOnly));
    this.#body.hidden = this.#sourceMode;
    this.#visualTools.hidden = this.#sourceMode;
    this.#sourceField.hidden = !this.#sourceMode;
    this.#source.readOnly = this.#readOnly;
    this.#mode.textContent = this.#sourceMode ? "Visual editor" : "Markdown";
    this.#mode.setAttribute(
      "aria-label",
      this.#sourceMode ? "Open visual editor" : "Edit Markdown source",
    );
    this.#toolbar.querySelectorAll("button").forEach((button) => {
      button.disabled = this.#readOnly;
    });
    if (this.#readOnly) this.#closePanel(false);
    this.#syncSource();
  }

  #syncSource() {
    if (!this.#sourceMode) return;
    if (this.#source.value !== this.#value) this.#source.value = this.#value;
    this.#sourceField.dataset.value = this.#source.value;
  }

  #validate() {
    const excess = this.#value.length - taskDescriptionLimit;
    this.#error.hidden = excess <= 0;
    this.#error.textContent =
      excess > 0
        ? `Remove ${excess.toLocaleString()} ${excess === 1 ? "character" : "characters"} to save. The Markdown limit is 20,000 characters.`
        : "";
    for (const input of [this.#body, this.#source]) {
      if (excess > 0) {
        input.setAttribute("aria-invalid", "true");
        input.setAttribute("aria-describedby", this.#error.id);
      } else {
        input.removeAttribute("aria-invalid");
        input.removeAttribute("aria-describedby");
      }
    }
  }

  #changed(markdown: string) {
    if (markdown === this.#value) return;
    this.#value = markdown;
    this.#syncSource();
    this.#validate();
    this.dispatchEvent(
      new CustomEvent("description-edited", {
        detail: markdown,
        bubbles: true,
      }),
    );
  }

  #flush() {
    if (!this.#sourceMode) this.#editor.read(() => {});
  }

  #onFocusOut = (event: FocusEvent) => {
    if (
      event.relatedTarget instanceof Node &&
      this.contains(event.relatedTarget)
    )
      return;
    this.#flush();
    this.#closePanel(false);
    this.dispatchEvent(
      new CustomEvent("description-blurred", {
        detail: this.#value,
        bubbles: true,
      }),
    );
  };

  #edit(run: () => void) {
    if (this.#readOnly || this.#sourceMode) return;
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
    this.#link.hidden = true;
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
      this.#closePanel(false);
    }
  }

  #openLink() {
    if (this.#readOnly) return;
    this.#flush();
    this.#closePanel(false);
    this.#url.value = this.#editor.read(() => {
      const selection = this.#selection;
      return selection
        ? ($findMatchingParent(
            selection.anchor.getNode(),
            $isLinkNode,
          )?.getURL() ?? "")
        : "";
    });
    this.#linkError.textContent = "";
    this.#link.hidden = false;
    this.#url.focus();
    this.#url.select();
  }

  #applyLink(remove = false) {
    const url = remove ? null : taskDescriptionLink(this.#url.value);
    if (!remove && !url) {
      this.#linkError.textContent =
        "Enter a valid HTTP, HTTPS, mailto or relative link.";
      this.#url.focus();
      return;
    }
    this.#edit(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      if (
        url &&
        selection.isCollapsed() &&
        !$findMatchingParent(selection.anchor.getNode(), $isLinkNode)
      ) {
        selection.insertText(url);
        const end = selection.anchor.offset;
        selection.anchor.set(selection.anchor.key, end - url.length, "text");
      }
      $toggleLink(url);
    });
    this.#closePanel(false);
  }

  #closePanel(restoreFocus: boolean) {
    if (restoreFocus) this.#edit(() => {});
    this.#menu.hidden = true;
    this.#link.hidden = true;
    this.#insert.setAttribute("aria-expanded", "false");
  }

  #onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || this.#sourceMode || this.#readOnly) return;
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "Escape" && (!this.#menu.hidden || !this.#link.hidden)) {
      consume();
      this.#closePanel(true);
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
      event.target instanceof Node &&
      this.#body.contains(event.target)
    ) {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "k"
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
