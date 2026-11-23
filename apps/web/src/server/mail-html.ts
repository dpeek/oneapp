import type { Attachment } from "postal-mime";
import sanitizeHtml from "sanitize-html";
import { hiddenMailElement } from "./mail-image-policy.ts";
import { attachmentPart } from "./mail-attachments.ts";

// Bound encoding work and repeated references in the rendered document.
const inlineImageBudget = 5 * 1024 * 1024;
// App-owned transparent pixel: unresolved images never expose a broken-image icon.
export const mailImagePlaceholder =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const contentId = (value: string) => value.trim().replace(/^<|>$/gu, "");
const color = [/^#[\da-f]{3,8}$/iu, /^[a-z]+$/iu, /^rgba?\([\d.,%\s]+\)$/iu];
// Only literal presentation values: no URLs, functions, CSS variables or escapes.
const lengthValue = String.raw`\d{1,4}(?:\.\d{1,2})?(?:px|em|rem|%)?`;
const length = [new RegExp(`^${lengthValue}$`, "iu")];
const lengths = [
  new RegExp(`^${lengthValue}(?:\\s+${lengthValue}){0,3}$`, "iu"),
];
const marginValue = `(?:auto|${lengthValue})`;
const margins = [
  new RegExp(`^${marginValue}(?:\\s+${marginValue}){0,3}$`, "iu"),
];
const border = [
  /^(?:0|none)$/iu,
  new RegExp(
    `^${lengthValue}\\s+(?:solid|dashed|dotted|double)\\s+(?:#[\\da-f]{3,8}|[a-z]+|rgba?\\([\\d.,%\\s]+\\))$`,
    "iu",
  ),
];

const placeholderStyle = (attrs: Record<string, string>) => {
  const style = attrs.style ?? "";
  // Our frame uses height:auto for real images. A square pixel with only a
  // width would otherwise expand into a large square. Keep the declared height,
  // or reserve just one pixel when the sender supplied no usable height.
  const heights = [
    ...style
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .matchAll(/(?:^|;)\s*height\s*:\s*([^;]+)/giu),
  ].map((match) => match[1]!.replace(/\s*!important\s*$/iu, "").trim());
  const declared =
    heights.findLast((value) => length.some((rule) => rule.test(value))) ??
    attrs.height ??
    "";
  const height = length.some((rule) => rule.test(declared))
    ? /^\d+(?:\.\d+)?$/u.test(declared)
      ? `${declared}px`
      : declared
    : "1px";
  return `${style};height:${height} !important`;
};

export const sanitizeMailHtml = (
  html: string,
  attachments: readonly Attachment[],
  remote?: (
    source: string,
    attrs: Record<string, string>,
    hidden: boolean,
    remaining: number,
  ) => string | undefined,
) => {
  const parts = new Map<string, number>();
  attachments.forEach((attachment, part) => {
    if (attachment.contentId) {
      const id = contentId(attachment.contentId);
      if (!parts.has(id)) parts.set(id, part);
    }
  });
  const hidden: boolean[] = [];
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
    onOpenTag: (_name, attrs) => {
      hidden.push(Boolean(hidden.at(-1)) || hiddenMailElement(attrs));
    },
    onCloseTag: () => {
      hidden.pop();
    },
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
      "*": ["style", "dir", "lang", "title", "hidden"],
      a: ["href", "target", "rel"],
      img: ["src", "alt", "width", "height"],
      table: [
        "width",
        "height",
        "cellpadding",
        "cellspacing",
        "border",
        "align",
        "bgcolor",
      ],
      tr: ["align", "valign", "bgcolor"],
      td: [
        "colspan",
        "rowspan",
        "width",
        "height",
        "align",
        "valign",
        "bgcolor",
      ],
      th: [
        "colspan",
        "rowspan",
        "width",
        "height",
        "align",
        "valign",
        "scope",
        "bgcolor",
      ],
      col: ["span", "width"],
      ol: ["start", "type"],
      li: ["value"],
    },
    nonBooleanAttributes: sanitizeHtml.defaults.nonBooleanAttributes.filter(
      (attribute) => attribute !== "hidden",
    ),
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
        "font-family": [/^[a-z\d ,'"-]{1,300}$/iu],
        "line-height": [...length, /^normal$/iu],
        "letter-spacing": [...length, /^normal$/iu],
        "text-transform": [/^(none|uppercase|lowercase|capitalize)$/iu],
        display: [
          /^(none|block|inline|inline-block|table|table-row|table-cell)$/iu,
        ],
        visibility: [/^(visible|hidden|collapse)$/iu],
        opacity: [/^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/u],
        overflow: [/^(visible|hidden|auto|scroll)$/iu],
        "font-weight": [/^(normal|bold|[1-9]00)$/u],
        "font-style": [/^(normal|italic|oblique)$/u],
        "text-decoration": [/^(none|underline|line-through)$/u],
        "text-align": [/^(left|right|center|justify|start|end)$/u],
        "vertical-align": [
          /^(top|middle|bottom|baseline|text-top|text-bottom|sub|super)$/u,
        ],
        "white-space": [/^(normal|nowrap|pre|pre-wrap|pre-line)$/u],
        "border-collapse": [/^(collapse|separate)$/u],
        border,
        "border-top": border,
        "border-right": border,
        "border-bottom": border,
        "border-left": border,
        "border-color": color,
        "border-style": [/^(none|solid|dashed|dotted|double)$/iu],
        "border-width": lengths,
        "border-radius": lengths,
        "border-top-left-radius": length,
        "border-top-right-radius": length,
        "border-bottom-left-radius": length,
        "border-bottom-right-radius": length,
        "border-spacing": lengths,
        "table-layout": [/^(auto|fixed)$/iu],
        width: [...length, /^auto$/iu],
        height: [...length, /^auto$/iu],
        "max-height": length,
        "min-height": length,
        "min-width": length,
        margin: margins,
        "margin-top": margins,
        "margin-bottom": margins,
        "margin-left": margins,
        "margin-right": margins,
        "max-width": length,
        padding: lengths,
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
        let src = inlineImage(original ?? "");
        if (!src && remote && hidden.length <= 48) {
          const resolved = remote(
            original ?? "",
            attribs,
            Boolean(hidden.at(-1)),
            remaining,
          );
          if (
            resolved &&
            resolved.length <= remaining &&
            /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/u.test(
              resolved,
            )
          ) {
            remaining -= resolved.length;
            src = resolved;
          }
        }
        return {
          tagName,
          attribs: {
            ...rest,
            src: src ?? mailImagePlaceholder,
            ...(!src ? { style: placeholderStyle(attribs) } : {}),
            alt: attribs.alt ?? (src ? "Embedded image" : ""),
          },
        };
      },
    },
  });
};
