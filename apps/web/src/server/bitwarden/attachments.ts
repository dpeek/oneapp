import { Result, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import {
  AttachmentId,
  AttachmentMetadata,
} from "../../vault-attachment-contract.ts";
import { VaultItemId } from "../../vault-items-contract.ts";
import { optionalDate } from "../../vault-item-content.ts";
import {
  deleteAttachment,
  downloadAttachment,
  readAttachment,
  reserveAttachment,
  saveAttachmentBytes,
  scheduleAttachmentCleanup,
} from "../vault/attachments.ts";
import {
  readPersonalItem,
  type PersonalVault,
  type VaultAuthorization,
} from "../vault/personal.ts";
import { error, json, readJson } from "./http.ts";
import { attachmentDownloadAuthorization } from "./store.ts";
import * as Wire from "./wire.ts";

const downloadPath =
  /^\/api\/attachment-download\/([0-9a-f-]{36})\/([0-9a-f]{32})$/u;
const attachmentPath =
  /^\/api\/ciphers\/([0-9a-f-]{36})\/attachment\/(v2|[0-9a-f]{32})$/u;
export const isAttachmentPath = (path: string) =>
  attachmentPath.test(path) || downloadPath.test(path);

const handshake = Schema.is(
  Schema.Struct({
    fileName: AttachmentMetadata.fields.name,
    key: AttachmentMetadata.fields.wrappedKey,
    fileSize: Schema.Union([
      Schema.Int,
      Schema.String.check(Schema.isPattern(/^\d{1,8}$/u)),
    ]),
    lastKnownRevisionDate: optionalDate,
    adminRequest: Schema.optionalKey(Schema.Literal(false)),
  }),
);
const isId = Schema.is(VaultItemId);
const isAttachmentId = Schema.is(AttachmentId);

const macKey = (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
const signedMessage = (path: string, id: string, exp: number) =>
  new TextEncoder().encode(
    `oneapp-attachment-download\n${path}\n${id}\n${exp}`,
  );
const downloadLifetime = 60_000;

const makeDownloadUrl = async (
  env: WorkerEnv,
  item: string,
  attachment: string,
  device: string,
) => {
  const url = new URL(
    `/api/attachment-download/${item}/${attachment}`,
    env.APP_ORIGIN,
  );
  const expiry = Date.now() + downloadLifetime;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await macKey(env.AUTH_SECRET),
    signedMessage(url.pathname, device, expiry),
  );
  url.search = new URLSearchParams({
    device,
    expiry: String(expiry),
    proof: Base64Url.encode(new Uint8Array(signature)),
  }).toString();
  return url.href;
};

export const transferDownload = async (
  request: Request,
  url: URL,
  env: WorkerEnv,
) => {
  const match = downloadPath.exec(url.pathname);
  if (!match) return null;
  const [, item, attachment] = match;
  if (request.method !== "GET") return error("method_not_allowed", 405);
  if (!env.VAULT_FILES || !isId(item) || !isAttachmentId(attachment))
    return error("attachment_not_found", 404);
  const device = url.searchParams.get("device");
  const expiry = Number(url.searchParams.get("expiry"));
  const proof = url.searchParams.get("proof") ?? "";
  const now = Date.now();
  if (
    !isId(device) ||
    !Number.isSafeInteger(expiry) ||
    expiry <= now ||
    expiry > now + downloadLifetime ||
    !/^[\w-]{43}$/u.test(proof)
  )
    return error("invalid_transfer", 401);
  const signature = Base64Url.decode(proof);
  if (
    Result.isFailure(signature) ||
    !(await crypto.subtle.verify(
      "HMAC",
      await macKey(env.AUTH_SECRET),
      new Uint8Array(signature.success),
      signedMessage(url.pathname, device, expiry),
    ))
  )
    return error("invalid_transfer", 401);
  return (
    (await downloadAttachment(
      env.DB,
      env.VAULT_FILES,
      attachmentDownloadAuthorization(device),
      item,
      attachment,
    )) ?? error("attachment_not_found", 404)
  );
};

export const bitwardenAttachments = async (
  request: Request,
  path: string,
  env: WorkerEnv,
  vault: PersonalVault,
  authorization: VaultAuthorization,
  deviceId: string,
  defer: (work: Promise<unknown>) => void,
) => {
  const [, item, attachmentId] = attachmentPath.exec(path) ?? [];
  if (!env.VAULT_FILES || !isId(item))
    return error("attachment_not_found", 404);
  if (attachmentId === "v2" && request.method === "POST") {
    const body = await readJson(request, 128 * 1024);
    if (!handshake(body)) return error("invalid_attachment");
    const cipher = await readPersonalItem(env.DB, vault.id, item);
    if (!cipher) return error("cipher_not_found", 404);
    const expected = body.lastKnownRevisionDate
      ? Date.parse(body.lastKnownRevisionDate)
      : cipher.revisionAt;
    const result = await reserveAttachment(
      env.DB,
      authorization,
      item,
      expected,
      {
        name: body.fileName,
        wrappedKey: body.key,
        size: Number(body.fileSize),
      },
    );
    if (result.status !== "ready") return attachmentError(result.status);
    const attachment = result.attachment;
    const latest = await readPersonalItem(env.DB, vault.id, item);
    if (!latest) return error("cipher_not_found", 404);
    return json({
      object: "attachment-fileUpload",
      attachmentId: attachment.id,
      fileUploadType: 0,
      url: `/ciphers/${item}/attachment/${attachment.id}`,
      cipherResponse: Wire.cipher({
        ...latest,
        revisionAt: Math.max(latest.revisionAt, attachment.revisionAt),
        attachments: [
          ...latest.attachments.filter(({ id }) => id !== attachment.id),
          attachment,
        ],
      }),
    });
  }
  if (!isAttachmentId(attachmentId)) return error("method_not_allowed", 405);
  if (request.method === "POST") {
    const result = await saveAttachmentBytes(
      env.DB,
      env.VAULT_FILES,
      authorization,
      item,
      attachmentId,
      request,
    );
    if (result !== "updated") return attachmentError(result);
    return new Response(null, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  }
  if (request.method === "GET") {
    const attachment = await readAttachment(
      env.DB,
      authorization,
      item,
      attachmentId,
    );
    if (attachment?.readyAt == null) return error("attachment_not_found", 404);
    return json(
      Wire.attachment(
        attachment,
        await makeDownloadUrl(env, item, attachmentId, deviceId),
      ),
    );
  }
  if (request.method === "DELETE") {
    const deleted = await deleteAttachment(
      env.DB,
      authorization,
      item,
      attachmentId,
    );
    if (deleted !== "updated") return attachmentError(deleted);
    scheduleAttachmentCleanup(env, defer);
    const cipher = await readPersonalItem(env.DB, vault.id, item);
    return cipher
      ? json({ object: "deleteAttachment", cipher: Wire.cipher(cipher) })
      : error("cipher_not_found", 404);
  }
  return error("method_not_allowed", 405);
};

const attachmentError = (result: "not_found" | "quota" | "size" | "stale") => {
  switch (result) {
    case "not_found":
      return error("attachment_not_found", 404);
    case "quota":
      return json(
        {
          error: "attachment_quota",
          message: "This vault has reached its 64 MiB attachment quota.",
        },
        413,
      );
    case "size":
      return json(
        {
          error: "invalid_attachment_size",
          message:
            "The encrypted file must match its declared size and fit within 8 MiB.",
        },
        413,
      );
    case "stale":
      return json(
        {
          error: "stale_attachment",
          message: "The item or upload changed. Sync your vault and try again.",
        },
        409,
      );
  }
};
