import { inboxComposeLimits } from "./inbox-contract.ts";
import { mailEditor } from "./mail-editor-contract.ts";
import { editorLink, type EditorBody } from "./mail-format.ts";
import { editorHtml, parseEditorHtml } from "./mail-editor-dom.ts";

const button = (text: string, label: string, run: () => void) => {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.title = label;
  element.setAttribute("aria-label", label);
  element.addEventListener("mousedown", (event) => event.preventDefault());
  element.addEventListener("click", run);
  return element;
};

export class MailEditor extends HTMLElement {
  static formAssociated = true;
  #internals = this.attachInternals();
  #editor = document.createElement("div");
  #format = document.createElement("details");
  #link = document.createElement("div");
  #url = document.createElement("input");
  #error = document.createElement("span");
  #buttons = new Map<string, HTMLButtonElement>();
  #selection: Range | null = null;
  #listeners: AbortController | null = null;
  #value: EditorBody = { text: "" };
  #readOnly = false;
  #built = false;

  get value() {
    return this.#value;
  }
  set value(value: EditorBody) {
    if (this.#value.text === value.text && this.#value.html === value.html)
      return;
    this.#value = value;
    if (value.html !== undefined)
      this.#editor.replaceChildren(parseEditorHtml(value.html));
    else this.#editor.textContent = value.text;
    this.#selection = null;
    if (!value.text) {
      this.#format.open = false;
      this.#link.hidden = true;
    }
    this.#validate();
  }

  get readOnly() {
    return this.#readOnly;
  }
  set readOnly(value: boolean) {
    this.#readOnly = value;
    this.#editor.contentEditable = String(!value);
    this.#editor.setAttribute("aria-readonly", String(value));
    this.querySelectorAll("button, input").forEach((control) => {
      if (
        control instanceof HTMLButtonElement ||
        control instanceof HTMLInputElement
      )
        control.disabled = value;
    });
  }
  set label(value: string) {
    this.#editor.setAttribute("aria-label", value);
  }
  set compact(value: boolean) {
    this.classList.toggle("mail-editor-compact", value);
  }
  override focus(options?: FocusOptions) {
    this.#editor.focus(options);
  }

  connectedCallback() {
    if (!this.#built) this.#build();
    this.#listeners?.abort();
    this.#listeners = new AbortController();
    document.addEventListener(
      "selectionchange",
      () => this.#rememberSelection(),
      { signal: this.#listeners.signal },
    );
    this.#validate();
  }
  disconnectedCallback() {
    this.#listeners?.abort();
  }

  #build() {
    this.#built = true;
    this.classList.add("mail-editor");
    this.#editor.className = "mail-editor-body";
    this.#editor.contentEditable = String(!this.#readOnly);
    this.#editor.setAttribute("role", "textbox");
    this.#editor.setAttribute("aria-multiline", "true");
    this.#editor.setAttribute("aria-required", "true");
    this.#editor.spellcheck = true;
    this.#editor.addEventListener("input", () => this.#changed());
    this.#editor.addEventListener("paste", (event) => {
      event.preventDefault();
      if (!this.#readOnly)
        this.#insertText(event.clipboardData?.getData("text/plain") ?? "");
    });
    // Prevent HTML/file drops from bypassing the plain-text paste boundary.
    this.#editor.addEventListener("dragover", (event) =>
      event.preventDefault(),
    );
    this.#editor.addEventListener("drop", (event) => event.preventDefault());
    this.#editor.addEventListener("click", (event) => {
      if ((event.target as Element).closest("a")) event.preventDefault();
    });
    this.#editor.addEventListener("keydown", (event) => {
      if (event.isComposing || this.#readOnly) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey) {
        const command = { b: "bold", i: "italic", k: "link" }[
          event.key.toLowerCase()
        ];
        if (command) {
          event.preventDefault();
          if (command === "link") this.#openLink();
          else this.#command(command);
        } else if (event.key === "Enter") {
          event.preventDefault();
          this.#internals.form?.requestSubmit();
        }
      }
    });
    this.#format.className = "mail-editor-format";
    const summary = document.createElement("summary");
    summary.textContent = "Aa";
    summary.title = "Formatting";
    summary.setAttribute("aria-label", "Formatting");
    const toolbar = document.createElement("div");
    toolbar.className = "mail-editor-toolbar";
    toolbar.setAttribute("role", "group");
    toolbar.setAttribute("aria-label", "Text formatting");
    for (const [command, text, label] of [
      ["bold", "B", "Bold (⌘/Ctrl+B)"],
      ["italic", "I", "Italic (⌘/Ctrl+I)"],
      ["insertUnorderedList", "• List", "Bulleted list"],
      ["insertOrderedList", "1. List", "Numbered list"],
    ] as const) {
      const control = button(text, label, () => this.#command(command));
      control.setAttribute("aria-pressed", "false");
      this.#buttons.set(command, control);
      toolbar.append(control);
    }
    toolbar.append(
      button("Link", "Add or edit link (⌘/Ctrl+K)", () => this.#openLink()),
    );
    toolbar.append(
      button("Unlink", "Remove link", () => this.#command("unlink")),
    );
    this.#link.className = "mail-editor-link";
    this.#link.hidden = true;
    this.#url.type = "text";
    this.#url.placeholder = "https://…";
    this.#url.setAttribute("aria-label", "Link URL");
    this.#url.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        this.#applyLink();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.#closeLink();
      }
    });
    this.#error.setAttribute("role", "alert");
    this.#link.append(
      this.#url,
      button("Apply", "Apply link", () => this.#applyLink()),
      button("Cancel", "Cancel link", () => this.#closeLink()),
      this.#error,
    );
    this.#format.append(summary, toolbar, this.#link);
    this.append(this.#editor, this.#format);
    this.readOnly = this.#readOnly;
  }

  #rememberSelection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (
      !this.#editor.contains(range.startContainer) ||
      !this.#editor.contains(range.endContainer)
    )
      return;
    this.#selection = range.cloneRange();
    for (const [command, control] of this.#buttons) {
      control.setAttribute(
        "aria-pressed",
        String(document.queryCommandState(command)),
      );
    }
  }
  #restoreSelection() {
    this.#editor.focus();
    const selection = window.getSelection();
    if (!selection) return;
    const range = this.#selection;
    selection.removeAllRanges();
    if (
      range &&
      this.#editor.contains(range.startContainer) &&
      this.#editor.contains(range.endContainer)
    )
      selection.addRange(range);
    else {
      const end = document.createRange();
      end.selectNodeContents(this.#editor);
      end.collapse(false);
      selection.addRange(end);
    }
  }
  #command(command: string, value?: string) {
    if (this.#readOnly) return;
    this.#restoreSelection();
    // Native editing commands preserve the browser's undo history. Keep this
    // compatibility boundary small until a dedicated editor is warranted.
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand(command, false, value);
    this.#rememberSelection();
    this.#changed();
  }
  #insertText(text: string) {
    this.#rememberSelection();
    const available = Math.max(
      0,
      inboxComposeLimits.text -
        this.#editor.innerText.length +
        (this.#selection?.toString().length ?? 0),
    );
    this.#command(
      "insertText",
      text.slice(0, available).replace(/[\uD800-\uDBFF]$/u, ""),
    );
  }
  #openLink() {
    if (this.#readOnly) return;
    this.#rememberSelection();
    this.#format.open = true;
    this.#link.hidden = false;
    const node = this.#selection?.startContainer;
    const anchor = (
      node instanceof Element ? node : node?.parentElement
    )?.closest("a");
    this.#url.value = anchor?.getAttribute("href") ?? "";
    this.#error.textContent = "";
    this.#url.focus();
    this.#url.select();
  }
  #applyLink() {
    if (this.#readOnly) return;
    const href = editorLink(this.#url.value);
    if (!href) {
      this.#error.textContent = "Enter an http, https, or mailto link.";
      return;
    }
    this.#restoreSelection();
    if (window.getSelection()?.isCollapsed) {
      const anchor = (
        this.#selection?.startContainer instanceof Element
          ? this.#selection.startContainer
          : this.#selection?.startContainer.parentElement
      )?.closest("a");
      if (anchor && this.#editor.contains(anchor)) {
        const range = document.createRange();
        range.selectNodeContents(anchor);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        this.#rememberSelection();
      } else {
        // createLink at a caret is inconsistent across engines. Insert escaped
        // markup through the native command so the operation is undoable.
        const a = document.createElement("a");
        a.href = href;
        a.textContent = href;
        this.#command("insertHTML", a.outerHTML);
        this.#link.hidden = true;
        return;
      }
    }
    this.#command("createLink", href);
    this.#link.hidden = true;
  }
  #closeLink() {
    this.#link.hidden = true;
    this.#restoreSelection();
  }
  #changed() {
    this.#value = {
      text: this.#editor.innerText.replaceAll("\u00a0", " "),
      html: editorHtml(this.#editor),
    };
    this.#validate();
    this.dispatchEvent(
      new CustomEvent("body-edited", { detail: this.#value, bubbles: true }),
    );
  }
  #validate() {
    if (!this.#built) return;
    const body = this.#value;
    const data = new FormData();
    data.set("text", body.text);
    if (body.html !== undefined) data.set("html", body.html);
    this.#internals.setFormValue(data);
    const empty = !body.text.trim();
    const tooLong =
      body.text.length > inboxComposeLimits.text ||
      (body.html?.length ?? 0) > inboxComposeLimits.html;
    this.#internals.setValidity(
      empty ? { valueMissing: true } : tooLong ? { tooLong: true } : {},
      empty ? "Enter a message." : tooLong ? "This message is too long." : "",
      this.#editor,
    );
  }
}

customElements.define(mailEditor.tag, MailEditor);
