import { convert } from "html-to-text";
import sanitizeHtml from "sanitize-html";
import { inboxComposeLimits } from "../inbox-contract.ts";
import { editorLink, type EditorBody } from "../mail-format.ts";

export const prepareMailBody = (body: EditorBody): EditorBody | null => {
  if (body.html === undefined) return { text: body.text };
  const html = sanitizeHtml(body.html, {
    allowedTags: [
      "p",
      "div",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "ul",
      "ol",
      "li",
      "blockquote",
      "a",
    ],
    allowedAttributes: { a: ["href"] },
    allowedSchemes: ["https", "http", "mailto"],
    allowProtocolRelative: false,
    nestingLimit: 48,
    nonTextTags: [
      "script",
      "style",
      "textarea",
      "option",
      "iframe",
      "object",
      "svg",
      "math",
      "template",
      "noscript",
      "xmp",
      "plaintext",
    ],
    transformTags: {
      a: (tagName, attributes) => {
        const href = editorLink(attributes.href ?? "");
        return { tagName, attribs: { ...(href ? { href } : {}) } };
      },
    },
  });
  const text = convert(html, {
    wordwrap: false,
    limits: { maxDepth: 48 },
    selectors: [{ selector: "a", options: { hideLinkHrefIfSameAsText: true } }],
  });
  return text.trim() &&
    text.length <= inboxComposeLimits.text &&
    html.length <= inboxComposeLimits.html
    ? { text, html }
    : null;
};
