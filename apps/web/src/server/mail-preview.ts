import { compile } from "html-to-text";
import { mailBodyPreview } from "../inbox-display.ts";

// Preview formatting is independent of the opened message and outgoing body.
const htmlPreviewText = compile({
  wordwrap: false,
  limits: { maxDepth: 48 },
  selectors: [
    { selector: ".gmail_quote", format: "blockquote" },
    { selector: ".yahoo_quoted", format: "blockquote" },
    { selector: "a", options: { ignoreHref: true } },
    ...["img", "script", "style", "svg"].map((selector) => ({
      selector,
      format: "skip",
    })),
  ],
});

export const mailPreview = (body: { text?: string; html?: string }) =>
  mailBodyPreview(
    body.html?.trim()
      ? htmlPreviewText(body.html.slice(0, 128 * 1024))
      : (body.text ?? ""),
  );
