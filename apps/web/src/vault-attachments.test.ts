import { expect, it } from "@effect/vitest";
import { encryptVaultAttachment } from "./vault-attachments.ts";
import {
  createVaultSetup,
  decryptFileBytes,
  decryptVaultText,
  encryptNewItem,
  unlockVault,
  unwrapVaultKey,
} from "./vault-crypto.ts";

it("encrypts attachment filenames and type-2 bytes independently with authenticated keys", async () => {
  const password = "disposable-vault-password";
  const setup = await createVaultSetup(password, "synthetic@example.net");
  const key = await unlockVault(password, { ...setup, kdfIterations: 600_000 });
  const { wrappedKey } = await encryptNewItem(key, async () => ({}));
  const itemKey = await unwrapVaultKey(wrappedKey, key, "both");
  const input = new File(["synthetic file contents"], "synthetic file.txt");
  const sealed = await encryptVaultAttachment(input, itemKey);
  expect(sealed.bytes[0]).toBe(2);
  expect((sealed.bytes.length - 49) % 16).toBe(0);
  expect(new TextDecoder().decode(sealed.bytes)).not.toContain(
    "synthetic file contents",
  );
  expect(await decryptVaultText(sealed.name, itemKey)).toBe(input.name);
  const fileKey = await unwrapVaultKey(sealed.wrappedKey, itemKey);
  expect(
    new TextDecoder().decode(await decryptFileBytes(sealed.bytes, fileKey)),
  ).toBe("synthetic file contents");
  sealed.bytes[17] = sealed.bytes[17]! ^ 1;
  await expect(decryptFileBytes(sealed.bytes, fileKey)).rejects.toThrow(
    "authentication",
  );
});
