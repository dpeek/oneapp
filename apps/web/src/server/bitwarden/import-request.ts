import { Schema } from "effect";
import {
  EncryptedVaultValue,
  VaultItemId,
  vaultItemBodyLimit,
} from "../../vault-items-contract.ts";
import {
  vaultImportFolders,
  vaultImportItems,
} from "../../vault-transfer-contract.ts";
import type { PersonalImport } from "../vault/import.ts";
import type { PersonalVault } from "../vault/personal.ts";
import { decodeCipher } from "./cipher-request.ts";

const Folder = Schema.Struct({
  id: Schema.optionalKey(Schema.NullOr(VaultItemId)),
  name: EncryptedVaultValue,
});
const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const ImportPayload = Schema.Struct({
  ciphers: Schema.Array(Schema.Unknown).check(
    Schema.isMaxLength(vaultImportItems),
  ),
  folders: Schema.Array(Folder).check(Schema.isMaxLength(vaultImportFolders)),
  folderRelationships: Schema.Array(
    Schema.Struct({ key: Index, value: Index }),
  ).check(Schema.isMaxLength(vaultImportItems)),
});

export const parseImport = (
  input: typeof ImportPayload.Type,
  vault: PersonalVault,
): { data: PersonalImport } | { error: string } => {
  const { ciphers, folders, folderRelationships } = input;
  if (!ciphers.length && !folders.length)
    return { error: "The import is empty." };
  const membership = new Map<number, number>();
  for (const { key, value } of folderRelationships) {
    if (key >= ciphers.length || value >= folders.length || membership.has(key))
      return { error: "An item has an invalid folder relationship." };
    membership.set(key, value);
  }
  const items: PersonalImport["items"] = [];
  for (const [index, cipher] of ciphers.entries()) {
    const parsed = decodeCipher(cipher);
    if (!parsed || JSON.stringify(cipher).length > vaultItemBodyLimit)
      return {
        error: `Item ${index + 1} has invalid or unsupported encrypted fields.`,
      };
    const {
      name,
      wrappedKey,
      type,
      details,
      encryptedFor,
      encryptedByKeyId,
      folderId,
      archivedDate,
      attachmentIds,
    } = parsed;
    if (attachmentIds.length)
      return { error: `Item ${index + 1} contains attachment references.` };
    if (
      (encryptedFor != null && encryptedFor !== vault.id) ||
      (encryptedByKeyId != null && encryptedByKeyId !== vault.keyId)
    )
      return {
        error: `Item ${index + 1} is encrypted for a different vault key.`,
      };
    if (
      folderId != null &&
      folders[membership.get(index) ?? -1]?.id !== folderId
    )
      return { error: `Item ${index + 1} has an invalid folder relationship.` };
    const archivedAt = archivedDate == null ? null : Date.parse(archivedDate);
    if (
      archivedAt !== null &&
      (!Number.isSafeInteger(archivedAt) || archivedAt < 0)
    )
      return { error: `Item ${index + 1} has an invalid archive date.` };
    items.push({
      name,
      wrappedKey,
      type,
      details,
      folderIndex: membership.get(index),
      archivedAt,
    } as PersonalImport["items"][number]);
  }
  return { data: { folders: [...folders], items } };
};
