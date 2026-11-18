import { Base64, Hex } from "effect/encoding";
import { type VaultSetup, vaultKdfIterations } from "./vault-setup-contract.ts";

const encoder = new TextEncoder();
const hmac = { name: "HMAC", hash: "SHA-256" };
const importMacKey = (bytes: Uint8Array<ArrayBuffer> | ArrayBuffer) =>
  crypto.subtle.importKey("raw", bytes, hmac, false, ["sign"]);

const wrap = async (
  plaintext: Uint8Array<ArrayBuffer> | ArrayBuffer,
  encryptionBytes: Uint8Array<ArrayBuffer> | ArrayBuffer,
  macBytes: Uint8Array<ArrayBuffer> | ArrayBuffer,
) => {
  const [encryptionKey, macKey] = await Promise.all([
    crypto.subtle.importKey("raw", encryptionBytes, "AES-CBC", false, [
      "encrypt",
    ]),
    importMacKey(macBytes),
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CBC", iv },
      encryptionKey,
      plaintext,
    ),
  );
  const authenticated = new Uint8Array(iv.length + ciphertext.length);
  authenticated.set(iv);
  authenticated.set(ciphertext, iv.length);
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", macKey, authenticated),
  );
  return `2.${[iv, ciphertext, mac].map(Base64.encode).join("|")}`;
};

export const createVaultSetup = async (
  password: string,
  kdfSalt: string,
): Promise<typeof VaultSetup.Type> => {
  const passwordBytes = encoder.encode(password);
  const userKey = crypto.getRandomValues(new Uint8Array(64));
  let masterBytes: Uint8Array<ArrayBuffer> | undefined;
  let encryptionBytes: Uint8Array<ArrayBuffer> | undefined;
  let macBytes: Uint8Array<ArrayBuffer> | undefined;
  let privateKeyBytes: Uint8Array<ArrayBuffer> | undefined;
  // Canonical CBOR for { 1: 4, -1: <64-byte symmetric key> } (RFC 9679).
  const thumbprintInput = new Uint8Array(70);
  try {
    const passwordKey = await crypto.subtle.importKey(
      "raw",
      passwordBytes,
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    masterBytes = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          iterations: vaultKdfIterations,
          salt: encoder.encode(kdfSalt),
        },
        passwordKey,
        256,
      ),
    );
    const masterKey = await importMacKey(masterBytes);
    // Bitwarden's legacy master key is the PRK for two single-block HKDF expansions.
    encryptionBytes = new Uint8Array(
      await crypto.subtle.sign("HMAC", masterKey, encoder.encode("enc\x01")),
    );
    macBytes = new Uint8Array(
      await crypto.subtle.sign("HMAC", masterKey, encoder.encode("mac\x01")),
    );
    const wrappedKey = await wrap(userKey, encryptionBytes, macBytes);

    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"],
    );
    privateKeyBytes = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
    );
    const publicKey = Base64.encode(
      new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey)),
    );
    thumbprintInput.set([0xa2, 0x01, 0x04, 0x20, 0x58, 0x40]);
    thumbprintInput.set(userKey, 6);
    const thumbprint = new Uint8Array(
      await crypto.subtle.digest("SHA-256", thumbprintInput),
    );
    return {
      kdfSalt,
      wrappedKey,
      keyId: Hex.encode(thumbprint.subarray(0, 16)),
      wrappedPrivateKey: await wrap(
        privateKeyBytes,
        userKey.subarray(0, 32),
        userKey.subarray(32),
      ),
      publicKey,
    };
  } finally {
    for (const bytes of [
      passwordBytes,
      userKey,
      masterBytes,
      encryptionBytes,
      macBytes,
      privateKeyBytes,
      thumbprintInput,
    ]) {
      bytes?.fill(0);
    }
  }
};
