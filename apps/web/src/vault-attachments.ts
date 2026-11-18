import { Schema } from "effect";
import {
  AttachmentMetadata,
  vaultAttachmentPath,
  vaultAttachmentsPath,
  vaultAttachmentClearLimit,
} from "./vault-attachment-contract.ts";
import {
  decryptFileBytes,
  encryptFileBytes,
  encryptNewItem,
  encryptVaultText,
  unwrapVaultKey,
  type VaultKey,
} from "./vault-crypto.ts";

export const encryptVaultAttachment = async (file: File, itemKey: VaultKey) => {
  if (file.size > vaultAttachmentClearLimit)
    throw new Error("Choose a file smaller than 8 MiB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return await encryptNewItem(itemKey, async (fileKey) => ({
      name: await encryptVaultText(file.name, itemKey),
      bytes: await encryptFileBytes(bytes, fileKey),
    }));
  } finally {
    bytes.fill(0);
  }
};

const csrf = { "x-effect-auth-csrf": "1" };

export const attachmentRequestError = async (response: Response) => {
  if (
    response.status === 400 ||
    response.status === 404 ||
    response.status === 409 ||
    response.status === 413
  ) {
    const result = (await response.json()) as { error?: string };
    if (result.error) return new Error(result.error);
  }
  return new Error("Could not update the attachment. Try again.");
};

export const uploadVaultAttachment = async (
  itemId: string,
  revision: number,
  keyId: string,
  encrypted: Awaited<ReturnType<typeof encryptVaultAttachment>>,
  signal: AbortSignal,
) => {
  const { name, wrappedKey, bytes } = encrypted;
  const reservation = await fetch(vaultAttachmentsPath(itemId), {
    method: "POST",
    headers: { ...csrf, "content-type": "application/json" },
    body: JSON.stringify({
      name,
      wrappedKey,
      size: bytes.length,
      expectedRevision: revision,
      keyId,
    }),
    signal,
  });
  if (!reservation.ok) throw await attachmentRequestError(reservation);
  const { id } = Schema.decodeUnknownSync(AttachmentMetadata)(
    await reservation.json(),
  );
  const upload = await fetch(vaultAttachmentPath(itemId, id), {
    method: "PUT",
    headers: { ...csrf, "content-type": "application/octet-stream" },
    body: bytes,
    signal,
  });
  if (!upload.ok) throw await attachmentRequestError(upload);
};

export const openVaultAttachment = async (
  item: string,
  attachment: AttachmentMetadata,
  itemKey: VaultKey,
  signal: AbortSignal,
) => {
  const response = await fetch(vaultAttachmentPath(item, attachment.id), {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("Could not download this attachment.");
  const ciphertext = new Uint8Array(await response.arrayBuffer());
  if (ciphertext.byteLength !== attachment.size)
    throw new Error("The encrypted attachment is incomplete.");
  const fileKey = await unwrapVaultKey(attachment.wrappedKey, itemKey);
  signal.throwIfAborted();
  return decryptFileBytes(ciphertext, fileKey);
};

export const removeVaultAttachment = async (
  itemId: string,
  id: string,
  signal: AbortSignal,
) => {
  const response = await fetch(vaultAttachmentPath(itemId, id), {
    method: "DELETE",
    headers: csrf,
    signal,
  });
  if (!response.ok) throw await attachmentRequestError(response);
};
