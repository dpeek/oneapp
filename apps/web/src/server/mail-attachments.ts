import type { R2Bucket } from "@cloudflare/workers-types";
import PostalMime, { type Attachment } from "postal-mime";
import {
  type InboxAttachment,
  inboxAttachmentTextPreviewLimit,
} from "../inbox-contract.ts";
import { privateHeaders } from "./api-response.ts";

export const receivedMessageLimit = 25 * 1024 * 1024;
export const mailMimeOptions = {
  maxHeadersSize: 256 * 1024,
  maxNestingDepth: 32,
  maxPartCount: 512,
  forceRfc822Attachments: true,
};

const textMediaTypes = new Set(["text/plain", "text/csv", "application/json"]);

const hasBytes = (bytes: Uint8Array, signature: readonly number[]) =>
  signature.every((byte, index) => bytes[index] === byte);

const rasterExtensions = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};
const detectMediaType = (bytes: Uint8Array) => {
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (hasBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  const signature = new TextDecoder().decode(bytes.subarray(0, 12));
  if (signature.startsWith("GIF87a") || signature.startsWith("GIF89a"))
    return "image/gif";
  if (signature.startsWith("RIFF") && signature.slice(8) === "WEBP")
    return "image/webp";
  if (signature.startsWith("%PDF-")) return "application/pdf";
  return null;
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
  const detected = detectMediaType(bytes);
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

const disposition = (name: string) => {
  const fallback = name.replaceAll(/[^\x20-\x7e]|[%"]/gu, "_");
  const encoded = encodeURIComponent(name).replaceAll(
    /['()*]/gu,
    (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

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
  const raw = await object.arrayBuffer();
  const email = await PostalMime.parse(raw, mailMimeOptions).catch(() => null);
  const attachment = email?.attachments[part];
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
          : disposition(metadata.name),
      "content-length": String(body.byteLength),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer",
    },
  });
};
