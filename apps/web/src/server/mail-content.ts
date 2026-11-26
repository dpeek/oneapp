import type { R2Bucket, R2ObjectBody } from "@cloudflare/workers-types";
import { compile } from "html-to-text";
import PostalMime, { type Email } from "postal-mime";
import { mailMimeOptions, receivedMessageLimit } from "./mail-attachments.ts";
import { mailPreview } from "./mail-preview.ts";

const htmlToText = compile({
  wordwrap: false,
  limits: { maxDepth: 48 },
  selectors: [
    { selector: ".gmail_quote", format: "blockquote" },
    { selector: ".yahoo_quoted", format: "blockquote" },
    { selector: "img", format: "skip" },
    { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
    { selector: "script", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "svg", format: "skip" },
  ],
});

export const readableMessage = (
  email: Pick<Email, "text" | "html">,
  htmlLimit: number,
) => {
  const html = email.text?.trim() ? "" : (email.html ?? "");
  return {
    html,
    text: html ? htmlToText(html.slice(0, htmlLimit)) : (email.text ?? ""),
  };
};

export const readMailMime = async (object: R2ObjectBody) => {
  if (object.size > receivedMessageLimit) {
    await object.body.cancel();
    return { status: "tooLarge" } as const;
  }
  const bytes = await object.arrayBuffer();
  const email = await PostalMime.parse(bytes, mailMimeOptions).catch(
    () => null,
  );
  return email
    ? ({ status: "complete", email } as const)
    : ({ status: "unreadable" } as const);
};

export const readRawMailPreview = async (bucket: R2Bucket, id: string) => {
  // The body usually precedes attachments. A ranged read bounds list work.
  const object = await bucket.get(id, {
    range: { offset: 0, length: 128 * 1024 },
  });
  if (!object) return;
  const bytes = await object.arrayBuffer();
  const email = await PostalMime.parse(bytes, mailMimeOptions).catch(
    () => null,
  );
  return email ? mailPreview(email) : "";
};

export const readHeaders = async (
  bucket: R2Bucket,
  id: string,
  length: number,
) => {
  const object = await bucket.get(id, { range: { offset: 0, length } });
  if (!object) return null;
  const raw = await object.text();
  const boundary = raw.search(/\r\n\r\n|\n\n|\r\r/u);
  try {
    const email = await PostalMime.parse(
      (boundary < 0 ? raw : raw.slice(0, boundary)) + "\r\n\r\n",
      mailMimeOptions,
    );
    return { email, metadata: object.customMetadata };
  } catch {
    return { email: null, metadata: object.customMetadata };
  }
};
