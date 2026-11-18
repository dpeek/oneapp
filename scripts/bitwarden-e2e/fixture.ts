import {
  createCipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
} from "node:crypto";

import type {
  PersonalItem,
  PersonalVault,
} from "../../apps/web/src/server/vault/personal.ts";

export const fixtureEmail = "owner@oneapp.test";
export const masterPassword = "OneApp compatibility fixture only";
export const itemName = "OneApp test login";
export const itemUsername = "oneapp-fixture-user";
export const itemPassword = "fixture-password-for-sync";

const encrypt = (value: string | Buffer, key: Buffer) => {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(value)),
    cipher.final(),
  ]);
  const mac = createHmac("sha256", key.subarray(32))
    .update(iv)
    .update(ciphertext)
    .digest();
  return `2.${[iv, ciphertext, mac].map((value) => value.toString("base64")).join("|")}`;
};

export const makeFixture = (origin: string) => {
  const userKey = randomBytes(64);
  const itemKey = randomBytes(64);
  // Canonical CBOR for the RFC 9679 symmetric COSE key map { 1: 4, -1: userKey }.
  const userKeyId = createHash("sha256")
    .update(Buffer.from("a20104205840", "hex"))
    .update(userKey)
    .digest()
    .subarray(0, 16)
    .toString("hex");
  const iterations = 600_000;
  const masterKey = pbkdf2Sync(
    masterPassword,
    fixtureEmail,
    iterations,
    32,
    "sha256",
  );
  const stretch = (purpose: string) =>
    createHmac("sha256", masterKey)
      .update(purpose)
      .update(Buffer.from([1]))
      .digest();
  const key = encrypt(userKey, Buffer.concat([stretch("enc"), stretch("mac")]));
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "der" },
    publicKeyEncoding: { type: "spki", format: "der" },
  });
  const now = Date.now();
  const vault: PersonalVault = {
    id: randomUUID(),
    ownerId: "owner",
    kdfSalt: fixtureEmail,
    kdfIterations: iterations,
    wrappedKey: key,
    keyId: userKeyId,
    wrappedPrivateKey: encrypt(privateKey, userKey),
    publicKey: publicKey.toString("base64"),
    createdAt: now,
    revisionAt: now,
  };
  const login: Omit<PersonalItem, "details" | "deletedAt" | "type"> & {
    username: string;
    password: string;
    uri: string;
  } = {
    id: randomUUID(),
    vaultId: vault.id,
    name: encrypt(itemName, itemKey),
    wrappedKey: encrypt(itemKey, userKey),
    username: encrypt(itemUsername, itemKey),
    password: encrypt(itemPassword, itemKey),
    uri: encrypt(`${origin}/fixture-login`, itemKey),
    createdAt: now,
    revisionAt: now,
  };
  return { vault, login };
};
