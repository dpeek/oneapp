import { Schema } from "effect";
import { EncryptedVaultValue, WrappedItemKey } from "./vault-item-content.ts";

export const vaultAttachmentLimit = 8 * 1024 * 1024;
export const vaultAttachmentQuota = 64 * 1024 * 1024;
export const vaultAttachmentClearLimit = vaultAttachmentLimit - 65;
export const vaultAttachmentRequestLimit = vaultAttachmentLimit + 128 * 1024;
export const attachmentHeaderLength = 49;
export const AttachmentId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{32}$/u),
);
export const AttachmentMetadata = Schema.Struct({
  id: AttachmentId,
  name: EncryptedVaultValue,
  wrappedKey: WrappedItemKey,
  size: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(65),
    Schema.isLessThanOrEqualTo(vaultAttachmentLimit),
  ),
});
export type AttachmentMetadata = typeof AttachmentMetadata.Type;

export const vaultAttachmentsPath = (item: string) =>
  `/api/vault/attachments/${item}` as const;
export const vaultAttachmentPath = (item: string, attachment: string) =>
  `${vaultAttachmentsPath(item)}/${attachment}` as const;
