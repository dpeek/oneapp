import { Result } from "effect";
import { Base64, Hex } from "effect/encoding";
import type { EditableItemDetails, ItemDetails } from "./vault-item-content.ts";
import { type VaultSetup, vaultKdfIterations } from "./vault-setup-contract.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const hmac = { name: "HMAC", hash: "SHA-256" };
type Bytes = Uint8Array<ArrayBuffer>;
type Operation = "encrypt" | "decrypt";
type VaultKeyUsage = Operation | "both";

export type VaultKey = {
  encryption: CryptoKey;
  authentication: CryptoKey;
};

const importMacKey = (bytes: Bytes, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", bytes, hmac, false, [usage]);

const importSymmetricKey = async (
  encryption: Bytes,
  authentication: Bytes,
  usage: VaultKeyUsage,
): Promise<VaultKey> => {
  const [encryptionKey, authenticationKey] = await Promise.all([
    crypto.subtle.importKey(
      "raw",
      encryption,
      "AES-CBC",
      false,
      usage === "both" ? ["encrypt", "decrypt"] : [usage],
    ),
    crypto.subtle.importKey(
      "raw",
      authentication,
      hmac,
      false,
      usage === "both"
        ? ["sign", "verify"]
        : [usage === "encrypt" ? "sign" : "verify"],
    ),
  ]);
  return { encryption: encryptionKey, authentication: authenticationKey };
};

const importVaultKey = (bytes: Bytes, usage: VaultKeyUsage) => {
  if (bytes.length !== 64) throw new Error("Invalid vault key length");
  return importSymmetricKey(bytes.subarray(0, 32), bytes.subarray(32), usage);
};

export const stretchVaultKey = async (bytes: Bytes, operation: Operation) => {
  const masterKey = await importMacKey(bytes, "sign");
  // Bitwarden uses the KDF output as the PRK for two single-block HKDF expansions.
  const encryption = new Uint8Array(
    await crypto.subtle.sign("HMAC", masterKey, encoder.encode("enc\x01")),
  );
  const authentication = new Uint8Array(
    await crypto.subtle.sign("HMAC", masterKey, encoder.encode("mac\x01")),
  );
  try {
    return await importSymmetricKey(encryption, authentication, operation);
  } finally {
    encryption.fill(0);
    authentication.fill(0);
  }
};

export const deriveMasterKey = async (
  password: string,
  kdfSalt: string,
  iterations: number,
  operation: Operation,
) => {
  const passwordBytes = encoder.encode(password);
  let masterBytes: Bytes | undefined;
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
          iterations,
          salt: encoder.encode(kdfSalt),
        },
        passwordKey,
        256,
      ),
    );
    return await stretchVaultKey(masterBytes, operation);
  } finally {
    passwordBytes.fill(0);
    masterBytes?.fill(0);
  }
};

const authenticatedBytes = (iv: Bytes, ciphertext: Bytes) => {
  const bytes = new Uint8Array(iv.length + ciphertext.length);
  bytes.set(iv);
  bytes.set(ciphertext, iv.length);
  return bytes;
};

const encryptParts = async (plaintext: Bytes, key: VaultKey) => {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CBC", iv },
      key.encryption,
      plaintext,
    ),
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key.authentication,
      authenticatedBytes(iv, ciphertext),
    ),
  );
  return { iv, ciphertext, mac };
};

const wrap = async (plaintext: Bytes, key: VaultKey) => {
  const { iv, ciphertext, mac } = await encryptParts(plaintext, key);
  return "2." + [iv, ciphertext, mac].map(Base64.encode).join("|");
};

const decodeBase64 = (encoded: string) => {
  const decoded = Base64.decode(encoded);
  if (Result.isFailure(decoded)) throw new Error("Invalid encrypted value");
  return new Uint8Array(decoded.success);
};

const decryptParts = async (
  iv: Bytes,
  ciphertext: Bytes,
  mac: Bytes,
  key: VaultKey,
) => {
  if (
    iv.length !== 16 ||
    mac.length !== 32 ||
    ciphertext.length === 0 ||
    ciphertext.length % 16 !== 0
  )
    throw new Error("Invalid encrypted value");
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key.authentication,
      mac,
      authenticatedBytes(iv, ciphertext),
    ))
  )
    throw new Error("Encrypted value failed authentication");
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-CBC", iv },
      key.encryption,
      ciphertext,
    ),
  );
};

const unwrap = async (value: string, key: VaultKey) => {
  const parts = value.slice(2).split("|");
  if (!value.startsWith("2.") || parts.length !== 3)
    throw new Error("Invalid encrypted value");
  const iv = decodeBase64(parts[0]!);
  const ciphertext = decodeBase64(parts[1]!);
  const mac = decodeBase64(parts[2]!);
  return decryptParts(iv, ciphertext, mac, key);
};

export const encryptFileBytes = async (plaintext: Bytes, key: VaultKey) => {
  const { iv, ciphertext, mac } = await encryptParts(plaintext, key);
  const file = new Uint8Array(49 + ciphertext.byteLength);
  file[0] = 2;
  file.set(iv, 1);
  file.set(mac, 17);
  file.set(ciphertext, 49);
  return file;
};

export const decryptFileBytes = (file: Bytes, key: VaultKey) => {
  if (file[0] !== 2 || file.byteLength < 65)
    throw new Error("Invalid encrypted file");
  return decryptParts(
    file.subarray(1, 17),
    file.subarray(49),
    file.subarray(17, 49),
    key,
  );
};

export const unwrapVaultKey = async (
  value: string,
  wrappingKey: VaultKey,
  usage: VaultKeyUsage = "decrypt",
) => {
  const bytes = await unwrap(value, wrappingKey);
  try {
    return await importVaultKey(bytes, usage);
  } finally {
    bytes.fill(0);
  }
};

export const unlockVault = async (
  password: string,
  {
    wrappedKey,
    kdfSalt,
    kdfIterations,
  }: {
    wrappedKey: string;
    kdfSalt: string;
    kdfIterations: number;
  },
) =>
  unwrapVaultKey(
    wrappedKey,
    await deriveMasterKey(password, kdfSalt, kdfIterations, "decrypt"),
    "both",
  );

export const decryptVaultText = async (value: string, key: VaultKey) => {
  const bytes = await unwrap(value, key);
  try {
    return decoder.decode(bytes);
  } finally {
    bytes.fill(0);
  }
};

const mapText = async (
  values: Readonly<Record<string, string | null>>,
  transform: (value: string) => Promise<string | null>,
) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(values).map(async ([name, value]) => [
        name,
        value === null ? null : await transform(value),
      ]),
    ),
  );

export const decryptItemDetails = async (
  details: typeof ItemDetails.Type,
  key: VaultKey,
): Promise<typeof EditableItemDetails.Type> => {
  const read = (value: string | null | undefined) =>
    value == null ? Promise.resolve(null) : decryptVaultText(value, key);
  const credentials = details.credentials;
  return {
    ...details,
    notes: await read(details.notes),
    fields: await Promise.all(
      (details.fields ?? []).map(async (field) => ({
        ...field,
        name: await read(field.name),
        value: await read(field.value),
      })),
    ),
    ...(credentials && {
      credentials: {
        autofillOnPageLoad: credentials.autofillOnPageLoad,
        passwordRevisionDate: credentials.passwordRevisionDate,
        username: await read(credentials.username),
        password: await read(credentials.password),
        totp: await read(credentials.totp),
        uris: await Promise.all(
          (credentials.uris ?? []).map(async ({ uri, match }) => ({
            uri: await read(uri),
            match,
          })),
        ),
      },
    }),
    ...(details.data && {
      data: await mapText(details.data, (value) =>
        decryptVaultText(value, key),
      ),
    }),
  };
};

export const encryptVaultText = async (value: string, key: VaultKey) => {
  const bytes = encoder.encode(value);
  try {
    return await wrap(bytes, key);
  } finally {
    bytes.fill(0);
  }
};

export const encryptOptionalText = (value: string, key: VaultKey) =>
  value === "" ? Promise.resolve(null) : encryptVaultText(value, key);

export const encryptNoteFields = async (
  title: string,
  note: string,
  key: VaultKey,
) => ({
  name: await encryptVaultText(title, key),
  notes: await encryptOptionalText(note, key),
});

export const encryptNewItem = async <Fields extends object>(
  userKey: VaultKey,
  encryptFields: (key: VaultKey) => Promise<Fields>,
) => {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  try {
    const key = await importVaultKey(bytes, "encrypt");
    return {
      wrappedKey: await wrap(bytes, userKey),
      ...(await encryptFields(key)),
    };
  } finally {
    bytes.fill(0);
  }
};

export const encryptSecureNote = (
  title: string,
  note: string,
  userKey: VaultKey,
) => encryptNewItem(userKey, (key) => encryptNoteFields(title, note, key));

export const encryptWebsite = async (website: string, key: VaultKey) => {
  const bytes = encoder.encode(website);
  try {
    const checksum = new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes),
    );
    return {
      uri: await wrap(bytes, key),
      // Bitwarden checks the encrypted Base64 SHA-256 of the exact URI.
      uriChecksum: await encryptVaultText(Base64.encode(checksum), key),
    };
  } finally {
    bytes.fill(0);
  }
};

export const encryptLogin = (
  login: { title: string; username: string; password: string; website: string },
  userKey: VaultKey,
) =>
  encryptNewItem(userKey, async (key) => ({
    type: 1 as const,
    name: await encryptVaultText(login.title, key),
    username: await encryptOptionalText(login.username, key),
    password: await encryptOptionalText(login.password, key),
    website:
      login.website === "" ? null : await encryptWebsite(login.website, key),
  }));

export const createVaultSetup = async (
  password: string,
  kdfSalt: string,
): Promise<typeof VaultSetup.Type> => {
  const userKey = crypto.getRandomValues(new Uint8Array(64));
  let privateKeyBytes: Bytes | undefined;
  // Canonical CBOR for { 1: 4, -1: <64-byte symmetric key> } (RFC 9679).
  const thumbprintInput = new Uint8Array(70);
  try {
    const masterKey = await deriveMasterKey(
      password,
      kdfSalt,
      vaultKdfIterations,
      "encrypt",
    );
    const wrappedKey = await wrap(userKey, masterKey);
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
        await importVaultKey(userKey, "encrypt"),
      ),
      publicKey,
    };
  } finally {
    userKey.fill(0);
    privateKeyBytes?.fill(0);
    thumbprintInput.fill(0);
  }
};
