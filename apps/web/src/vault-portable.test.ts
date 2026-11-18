import { expect, it } from "@effect/vitest";
import {
  createVaultSetup,
  unlockVault,
  unwrapVaultKey,
  decryptVaultText,
} from "./vault-crypto.ts";
import {
  readPortableVault,
  sealPortableVault,
  writePortableCsv,
  writePortableJson,
  writeProtectedExport,
} from "./vault-portable.ts";
import { decodeItem } from "./server/bitwarden/cipher-request.ts";

const passkey = {
  credentialId: "b64.CNcLdOn1RSKkJeXc1AEH5w",
  keyType: "public-key",
  keyAlgorithm: "ECDSA",
  keyCurve: "P-256",
  keyValue: "synthetic-test-private-key",
  rpId: "one.example",
  counter: "7",
  discoverable: "true",
  rpName: null,
  userHandle: "dGVzdA",
  userName: "disposable-user",
  creationDate: "2026-01-01T00:00:00.000Z",
};

const vault = {
  encrypted: false,
  folders: [{ id: crypto.randomUUID(), name: "Sample folder" }],
  items: [
    {
      name: 'Example login, with quotes "',
      type: 1,
      favorite: true,
      reprompt: 1,
      notes: "Line one\nLine two",
      fields: [{ type: 1, name: "Custom", value: "Synthetic hidden value" }],
      passwordHistory: [
        {
          password: "Prior synthetic password",
          lastUsedDate: "2026-01-01T00:00:00Z",
        },
      ],
      login: {
        username: "disposable-user",
        password: "Synthetic password",
        totp: "SYNTHETICSEED",
        fido2Credentials: [passkey],
        uris: [
          { uri: "https://one.example/a,b", match: 3 },
          { uri: "https://two.example", match: null },
        ],
      },
    },
    {
      name: "Example card",
      type: 3,
      card: {
        cardholderName: "Synthetic name",
        number: "Synthetic card number",
        expYear: "",
      },
    },
  ],
};
Object.assign(vault.items[0]!, { folderId: vault.folders[0]!.id });

it("round-trips portable JSON, CSV and password-protected JSON on the client", async () => {
  const original = await readPortableVault(JSON.stringify(vault));
  expect(await readPortableVault(writePortableJson(original))).toEqual(
    original,
  );
  const csv = await readPortableVault(writePortableCsv(original));
  expect(csv.items).toHaveLength(1);
  expect(csv.items[0]?.details.credentials?.fido2Credentials).toBeUndefined();
  expect(csv.items[0]?.details).toMatchObject({
    notes: "Line one\nLine two",
    credentials: {
      password: "Synthetic password",
      uris: [
        { uri: "https://one.example/a,b", match: null },
        { uri: "https://two.example", match: null },
      ],
    },
  });
  const sealed = await writeProtectedExport(
    original,
    "disposable-export-password",
  );
  expect(sealed).not.toContain("Synthetic password");
  expect(sealed).not.toContain(passkey.keyValue);
  await expect(readPortableVault(sealed, "wrong")).rejects.toThrow(
    "file password",
  );
  expect(await readPortableVault(sealed, "disposable-export-password")).toEqual(
    original,
  );
});

it("rejects unsupported records before sealing and sends only encrypted item values", async () => {
  const source = structuredClone(vault);
  source.items[0]!.login = {
    ...source.items[0]!.login,
    fido2Credentials: [{}],
  } as (typeof source.items)[0]["login"];
  await expect(readPortableVault(JSON.stringify(source))).rejects.toThrow(
    "passkey",
  );
  const setup = await createVaultSetup(
    "disposable-vault-password",
    "synthetic@example.net",
  );
  const key = await unlockVault("disposable-vault-password", {
    ...setup,
    kdfIterations: 600_000,
  });
  const data = await sealPortableVault(
    await readPortableVault(JSON.stringify(vault)),
    key,
  );
  const body = JSON.stringify(data);
  for (const value of [
    "Sample folder",
    "Synthetic password",
    "Synthetic hidden value",
    "two.example",
    "Synthetic card number",
    passkey.keyValue,
    passkey.credentialId,
    passkey.rpId,
  ])
    expect(body).not.toContain(value);
  expect(data.folderRelationships).toEqual([{ key: 0, value: 0 }]);
  const cipher = data.ciphers[0]!;
  const itemKey = await unwrapVaultKey(cipher.key, key);
  expect(await decryptVaultText(cipher.name, itemKey)).toEqual(
    vault.items[0]!.name,
  );
  const savedPasskey = decodeItem(JSON.stringify(cipher), false)?.details
    .credentials?.fido2Credentials?.[0];
  expect(savedPasskey).toBeDefined();
  const { creationDate, ...encryptedFields } = savedPasskey!;
  expect(creationDate).toBe(passkey.creationDate);
  for (const [field, ciphertext] of Object.entries(encryptedFields)) {
    const value =
      ciphertext == null
        ? ciphertext
        : await decryptVaultText(ciphertext, itemKey);
    expect(value).toBe(passkey[field as keyof typeof passkey]);
  }
  const cardCipher = data.ciphers[1]!;
  const cardDetails = (
    cardCipher as typeof cardCipher & { card: { expYear: string } }
  ).card;
  const cardKey = await unwrapVaultKey(cardCipher.key, key);
  expect(await decryptVaultText(cardDetails.expYear, cardKey)).toBe("");
  expect(await decryptVaultText(data.folders[0]!.name, key)).toBe(
    "Sample folder",
  );
});
