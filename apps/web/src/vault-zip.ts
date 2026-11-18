import {
  decryptVaultText,
  unwrapVaultKey,
  type VaultKey,
} from "./vault-crypto.ts";
import { openVaultAttachment } from "./vault-attachments.ts";
import { writePortableJson, type PortableVault } from "./vault-portable.ts";
import type { VaultSnapshot } from "./vault-items-contract.ts";

const safeSegment = (value: string, fallback: string) => {
  const sanitized = value
    .replace(/[/\\><:"|?*\u0000-\u001f\u007f]/gu, "_")
    .trim()
    .slice(0, 180);
  return !sanitized || sanitized === "." || sanitized === ".."
    ? fallback
    : sanitized;
};

export const writeVaultZip = async (
  vault: PortableVault,
  snapshot: typeof VaultSnapshot.Type,
  key: VaultKey,
  signal: AbortSignal,
) => {
  const { zipSync, strToU8 } = await import("fflate");
  const names = new Map(vault.items.map(({ id, name }) => [id, name]));
  const files: Record<string, Uint8Array<ArrayBuffer>> = {
    "data.json": strToU8(writePortableJson(vault)),
  };
  const failed: string[] = [];
  let count = 0;
  try {
    for (const item of snapshot.items) {
      if (!item.attachments.length) continue;
      signal.throwIfAborted();
      const itemName = names.get(item.id) ?? "Item";
      const prefix = `attachments/${safeSegment(itemName, "item")}-${item.id}/`;
      const itemKey = await unwrapVaultKey(item.wrappedKey, key);
      for (const attachment of item.attachments) {
        signal.throwIfAborted();
        let name = "Unreadable attachment name";
        try {
          name = await decryptVaultText(attachment.name, itemKey);
          const filename = safeSegment(name, "attachment");
          let path = prefix + filename;
          for (let copy = 1; Object.hasOwn(files, path); copy++)
            path = prefix + `${copy}-${filename}`;
          files[path] = await openVaultAttachment(
            item.id,
            attachment,
            itemKey,
            signal,
          );
          count++;
        } catch {
          signal.throwIfAborted();
          failed.push(`${itemName} / ${name}`);
        }
      }
    }
    if (failed.length)
      files["missing-attachments.txt"] = strToU8(failed.join("\n"));
    const archive = new Blob([zipSync(files, { level: 0 })], {
      type: "application/zip",
    });
    return { archive, count, failed };
  } finally {
    for (const bytes of Object.values(files)) bytes.fill(0);
  }
};
