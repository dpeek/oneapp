import type { R2Bucket } from "@cloudflare/workers-types";
import { Schema } from "effect";
import { OutgoingAttachments } from "../inbox-contract.ts";
import PostalMime, { type Attachment } from "postal-mime";
import {
  type InboxAttachment,
  inboxAttachmentTextPreviewLimit,
} from "../inbox-contract.ts";
import { attachmentDisposition, privateHeaders } from "./api-response.ts";
import { detectFilePreviewType } from "./file-preview-type.ts";

export const receivedMessageLimit = 25 * 1024 * 1024;
export const mailMimeOptions = {
  maxHeadersSize: 256 * 1024,
  maxNestingDepth: 32,
  maxPartCount: 512,
  forceRfc822Attachments: true,
};

const textMediaTypes = new Set(["text/plain", "text/csv", "application/json"]);

const rasterExtensions = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};
export const attachmentPart = (attachment: Attachment, part: number) => {
  const { content } = attachment;
  if (typeof content === "string") return null;
  const bytes =
    content instanceof ArrayBuffer
      ? new Uint8Array(content)
      : content.buffer instanceof ArrayBuffer
        ? new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
        : new Uint8Array(content);
  const detected = detectFilePreviewType(bytes);
  const declared = attachment.mimeType;
  const mediaType =
    detected ??
    (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(declared)
      ? declared
      : "application/octet-stream");
  const raster = detected && detected !== "application/pdf";
  const pdf = detected === "application/pdf";
  const extension = raster
    ? rasterExtensions[detected]
    : pdf
      ? ".pdf"
      : mediaType === "message/rfc822"
        ? ".eml"
        : "";
  const name =
    attachment.filename
      ?.split(/[/\\]/u)
      .at(-1)
      ?.replaceAll(/[<>:"|?*\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "_")
      .trim()
      .replace(/^[.]+|[. ]+$/gu, "")
      .slice(0, 240)
      .toWellFormed() || `attachment-${part + 1}${extension}`;
  const metadata: InboxAttachment = {
    part,
    name,
    mediaType,
    size: bytes.byteLength,
    preview: raster
      ? "image"
      : pdf
        ? "pdf"
        : textMediaTypes.has(mediaType)
          ? "text"
          : null,
  };
  return { metadata, bytes };
};

export const describeAttachments = (attachments: readonly Attachment[]) =>
  attachments.flatMap((attachment, part) => {
    const item = attachmentPart(attachment, part);
    return item ? [item.metadata] : [];
  });

export const attachmentResponse = async (
  bucket: R2Bucket,
  id: string,
  part: number,
  preview: boolean,
) => {
  const object = await bucket.get(id);
  if (!object) return null;
  if (object.size > receivedMessageLimit) {
    await object.body.cancel();
    return new Response(null, { status: 413, headers: privateHeaders });
  }
  const attachments =
    object.httpMetadata?.contentType === "application/json"
      ? await object.json().then((value) => {
          const record = Schema.decodeUnknownOption(
            Schema.Struct({ attachments: OutgoingAttachments }),
          )(value);
          return record._tag === "Some"
            ? record.value.attachments.map(outgoingMimeAttachment)
            : [];
        })
      : (
          await PostalMime.parse(
            await object.arrayBuffer(),
            mailMimeOptions,
          ).catch(() => null)
        )?.attachments;
  const attachment = attachments?.[part];
  const item = attachment && attachmentPart(attachment, part);
  if (!item) return null;
  const { metadata, bytes } = item;
  if (preview && !metadata.preview)
    return new Response(null, { status: 415, headers: privateHeaders });

  const body =
    preview && metadata.preview === "text"
      ? bytes.subarray(0, inboxAttachmentTextPreviewLimit)
      : bytes;
  return new Response(body, {
    headers: {
      ...privateHeaders,
      "content-type": preview
        ? metadata.preview === "text"
          ? "text/plain; charset=utf-8"
          : metadata.mediaType
        : "application/octet-stream",
      "content-disposition":
        preview && metadata.preview === "image"
          ? "inline"
          : attachmentDisposition(metadata.name),
      "content-length": String(body.byteLength),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer",
    },
  });
};

const outgoingMimeAttachment = (
  file: (typeof OutgoingAttachments.Type)[number],
): Attachment => ({
  filename: file.filename,
  mimeType: file.type,
  disposition: "attachment",
  related: false,
  content: Uint8Array.fromBase64(file.content),
});
export const describeOutgoingAttachments = (
  files: typeof OutgoingAttachments.Type,
) => describeAttachments(files.map(outgoingMimeAttachment));
