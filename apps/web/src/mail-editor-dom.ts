import { editorLink } from "./mail-format.ts";

const tags = new Set([
  "p",
  "div",
  "br",
  "strong",
  "em",
  "ul",
  "ol",
  "li",
  "blockquote",
  "a",
]);
const discard = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "svg",
  "math",
  "template",
  "noscript",
  "textarea",
]);

// Rebuild only authoring primitives. Parsed markup never enters the live DOM.
export const editorFragment = (source: ParentNode) => {
  const fragment = document.createDocumentFragment();
  const copy = (node: Node, parent: Node, depth: number) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const lines = (node.textContent ?? "").split("\n");
      lines.forEach((line, index) => {
        if (index) parent.appendChild(document.createElement("br"));
        parent.appendChild(document.createTextNode(line));
      });
      return;
    }
    if (!(node instanceof HTMLElement) || discard.has(node.localName)) return;
    if (depth >= 48) {
      parent.appendChild(document.createTextNode(node.textContent ?? ""));
      return;
    }
    const tag =
      node.localName === "b"
        ? "strong"
        : node.localName === "i"
          ? "em"
          : node.localName;
    let target = parent;
    if (tags.has(tag)) {
      const element = document.createElement(tag);
      if (tag === "a") {
        const href = editorLink(node.getAttribute("href") ?? "");
        if (href) element.setAttribute("href", href);
      }
      parent.appendChild(element);
      target = element;
    } else if (tag === "span") {
      // Some native editing engines use spans for bold/italic.
      if (
        node.style.fontWeight === "bold" ||
        Number(node.style.fontWeight) >= 600
      ) {
        const strong = document.createElement("strong");
        target.appendChild(strong);
        target = strong;
      }
      if (node.style.fontStyle === "italic") {
        const em = document.createElement("em");
        target.appendChild(em);
        target = em;
      }
    }
    node.childNodes.forEach((child) => copy(child, target, depth + 1));
  };
  source.childNodes.forEach((node) => copy(node, fragment, 0));
  return fragment;
};

export const parseEditorHtml = (html: string) => {
  const template = document.createElement("template");
  template.innerHTML = html;
  return editorFragment(template.content);
};

export const editorHtml = (element: HTMLElement) => {
  const template = document.createElement("template");
  template.content.append(editorFragment(element));
  return template.innerHTML;
};
