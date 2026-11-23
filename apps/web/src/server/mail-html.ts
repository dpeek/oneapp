import type { Attachment } from "postal-mime";
import sanitizeHtml from "sanitize-html";
import { attachmentPart } from "./mail-attachments.ts";

// Bound encoding work and repeated references in the rendered document.
const inlineImageBudget = 5 * 1024 * 1024;
const contentId = (value: string) => value.trim().replace(/^<|>$/gu, "");
const color = [/^#[\da-f]{3,8}$/iu, /^[a-z]+$/iu, /^rgba?\([\d.,%\s]+\)$/iu];
const length = [/^\d{1,4}(\.\d{1,2})?(px|em|rem|%)?$/u];

export const sanitizeMailHtml = (
  html: string,
  attachments: readonly Attachment[],
) => {
  const parts = new Map<string, number>();
  attachments.forEach((attachment, part) => {
    if (attachment.contentId) {
      const id = contentId(attachment.contentId);
      if (!parts.has(id)) parts.set(id, part);
    }
  });
  let remaining = inlineImageBudget;
  const images = new Map<number, string>();
  const inlineImage = (source: string) => {
    if (!/^cid:/iu.test(source)) return undefined;
    let id: string;
    try {
      id = contentId(decodeURIComponent(source.slice(4)));
    } catch {
      return undefined;
    }
    const part = parts.get(id);
    if (part === undefined) return undefined;
    let url = images.get(part);
    if (!url) {
      const item = attachmentPart(attachments[part]!, part);
      if (!item || item.metadata.preview !== "image") return undefined;
      if (Math.ceil(item.bytes.byteLength / 3) * 4 + 32 > remaining)
        return undefined;
      url = `data:${item.metadata.mediaType};base64,${item.bytes.toBase64()}`;
      images.set(part, url);
    }
    if (url.length > remaining) return undefined;
    remaining -= url.length;
    return url;
  };

  return sanitizeHtml(html, {
    allowedTags: [
      "a",
      "abbr",
      "b",
      "blockquote",
      "br",
      "caption",
      "code",
      "col",
      "colgroup",
      "dd",
      "del",
      "div",
      "dl",
      "dt",
      "em",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "i",
      "img",
      "li",
      "ol",
      "p",
      "pre",
      "s",
      "small",
      "span",
      "strong",
      "sub",
      "sup",
      "table",
      "tbody",
      "td",
      "tfoot",
      "th",
      "thead",
      "tr",
      "u",
      "ul",
    ],
    allowedAttributes: {
      "*": ["style", "dir", "lang", "title"],
      a: ["href", "target", "rel"],
      img: ["src", "alt", "width", "height"],
      table: ["width", "cellpadding", "cellspacing", "border"],
      td: ["colspan", "rowspan", "width", "height", "align", "valign"],
      th: ["colspan", "rowspan", "width", "height", "align", "valign", "scope"],
      col: ["span", "width"],
      ol: ["start", "type"],
      li: ["value"],
    },
    allowedSchemes: ["https", "http", "mailto"],
    allowedSchemesByTag: { img: ["data"] },
    allowProtocolRelative: false,
    nestingLimit: 48,
    nonTextTags: [
      "script",
      "style",
      "textarea",
      "option",
      "iframe",
      "object",
      "embed",
      "svg",
      "math",
      "template",
      "noscript",
      "xmp",
      "plaintext",
      "title",
    ],
    allowedStyles: {
      "*": {
        color,
        "background-color": color,
        "font-size": length,
        "font-weight": [/^(normal|bold|[1-9]00)$/u],
        "font-style": [/^(normal|italic|oblique)$/u],
        "text-decoration": [/^(none|underline|line-through)$/u],
        "text-align": [/^(left|right|center|justify|start|end)$/u],
        "vertical-align": [/^(top|middle|bottom|baseline)$/u],
        "white-space": [/^(normal|pre|pre-wrap|pre-line)$/u],
        "border-collapse": [/^(collapse|separate)$/u],
        width: length,
        "max-width": length,
        padding: length,
        "padding-top": length,
        "padding-bottom": length,
        "padding-left": length,
        "padding-right": length,
      },
    },
    transformTags: {
      a: (tagName, attribs) => {
        // Relative URLs would resolve against the app's origin in srcdoc.
        const { href: original, ...rest } = attribs;
        const href = original?.trim();
        const safe = href && /^(https?:\/\/|mailto:)/iu.test(href);
        return {
          tagName,
          attribs: {
            ...rest,
            ...(safe ? { href } : {}),
            target: "_blank",
            rel: "noopener noreferrer",
          },
        };
      },
      img: (tagName, attribs) => {
        const { src: original, ...rest } = attribs;
        const src = inlineImage(original ?? "");
        return {
          tagName,
          attribs: {
            ...rest,
            ...(src ? { src } : {}),
            alt: attribs.alt || (src ? "Embedded image" : "Image unavailable"),
          },
        };
      },
    },
  });
};
