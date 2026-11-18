import { expect, it, vi } from "@effect/vitest";
import { unzipSync, strFromU8 } from "fflate";
import { writeVaultZip } from "./vault-zip.ts";
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

it("makes a partial ZIP export visible when an attachment cannot be recovered", async () => {
  const password = "disposable-zip-vault-password";
  const setup = await createVaultSetup(password, "synthetic@example.net");
  const snapshot = { ...setup, kdfIterations: 600_000, trash: [], folders: [] };
  const key = await unlockVault(password, snapshot);
  const item = await encryptNewItem(key, async () => ({}));
  const itemKey = await unwrapVaultKey(item.wrappedKey, key, "both");
  const file = await encryptVaultAttachment(
    new File(["Synthetic"], "missing.txt"),
    itemKey,
  );
  const id = crypto.randomUUID();
  const fetchFile = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 404 }));
  try {
    const result = await writeVaultZip(
      {
        folders: [],
        items: [
          { id, name: "Sample note", type: 2, folderId: null, details: {} },
        ],
      },
      {
        ...snapshot,
        items: [
          {
            id,
            type: 2,
            name: "ciphertext",
            wrappedKey: item.wrappedKey,
            revision: 42,
            notes: null,
            requiresMasterPassword: false,
            details: {},
            folderId: null,
            archivedAt: null,
            attachments: [
              {
                id: "0".repeat(32),
                name: file.name,
                wrappedKey: file.wrappedKey,
                size: file.bytes.length,
              },
            ],
          },
        ],
      },
      key,
      new AbortController().signal,
    );
    expect(result.failed).toEqual(["Sample note / missing.txt"]);
    expect(result.count).toBe(0);
    const archive = unzipSync(
      new Uint8Array(await result.archive.arrayBuffer()),
    );
    expect(strFromU8(archive["missing-attachments.txt"]!)).toBe(
      "Sample note / missing.txt",
    );
    expect(archive["data.json"]).toBeDefined();
  } finally {
    fetchFile.mockRestore();
  }
});
