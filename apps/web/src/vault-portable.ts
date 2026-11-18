import { Base64 } from "effect/encoding";
import { Schema } from "effect";
import {
  ItemType,
  itemTypes,
  optionalDate,
  PasskeyCreationDate,
  PasskeyList,
  type EncryptedPasskey,
  type ItemDetails,
} from "./vault-item-content.ts";
import {
  decryptVaultText,
  deriveMasterKey,
  encryptNewItem,
  encryptVaultText,
  encryptWebsite,
  stretchVaultKey,
  unwrapVaultKey,
  type VaultKey,
} from "./vault-crypto.ts";
import { decryptItemDetails } from "./vault-item-editor.ts";
import {
  csvExportUris,
  readVaultCsv,
  writeVaultCsv,
} from "./vault-portable-csv.ts";
import {
  vaultImportFolders,
  vaultImportItems,
} from "./vault-transfer-contract.ts";
import type { VaultSnapshot } from "./vault-items-contract.ts";
import { vaultKdfIterations } from "./vault-setup-contract.ts";

type Details = typeof ItemDetails.Type;
type VaultItem = (typeof VaultSnapshot.Type)["items"][number];
type RecordValue = Record<string, unknown>;

export type PortableVault = {
  folders: { id: string; name: string }[];
  items: {
    id?: string;
    type: ItemType;
    name: string;
    folderId: string | null;
    archivedDate?: string | null;
    details: Details;
  }[];
};

const RecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const isObject = Schema.is(RecordSchema);
const requiredSmallText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64 * 1024),
);
const PlainText = Schema.optionalKey(
  Schema.NullOr(Schema.String.check(Schema.isMaxLength(64 * 1024))),
);
const listOf = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(
    Schema.NullOr(Schema.Array(schema).check(Schema.isMaxLength(100))),
  );
const fieldType = Schema.Literals([0, 1, 2, 3]);
const repromptType = Schema.Literals([0, 1]);
const optionalBoolean = Schema.optionalKey(Schema.NullOr(Schema.Boolean));
const plainMetadata = Schema.Struct({
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  name: requiredSmallText,
  type: ItemType,
  notes: PlainText,
  favorite: optionalBoolean,
  folderId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  archivedDate: optionalDate,
  deletedDate: optionalDate,
  reprompt: Schema.optionalKey(Schema.NullOr(repromptType)),
  fields: listOf(
    Schema.Struct({
      type: fieldType,
      name: PlainText,
      value: PlainText,
      linkedId: Schema.optionalKey(Schema.NullOr(Schema.Int)),
    }),
  ),
  passwordHistory: listOf(
    Schema.Struct({ lastUsedDate: optionalDate, password: PlainText }),
  ),
});
const plainLogin = Schema.Struct({
  username: PlainText,
  password: PlainText,
  totp: PlainText,
  autofillOnPageLoad: optionalBoolean,
  passwordRevisionDate: optionalDate,
  uris: listOf(
    Schema.Struct({
      uri: PlainText,
      match: Schema.optionalKey(
        Schema.NullOr(Schema.Literals([0, 1, 2, 3, 4, 5])),
      ),
    }),
  ),
});
const plainPasskeys = Schema.Struct({
  fido2Credentials: PasskeyList(
    Schema.Struct({
      credentialId: requiredSmallText,
      keyType: requiredSmallText,
      keyAlgorithm: requiredSmallText,
      keyCurve: requiredSmallText,
      keyValue: requiredSmallText,
      rpId: requiredSmallText,
      counter: Schema.String.check(
        Schema.isPattern(/^\d{1,10}$/u),
        Schema.makeFilter((counter) => Number(counter) <= 0xffff_ffff),
      ),
      discoverable: Schema.Literals(["true", "false"]),
      userHandle: PlainText,
      userName: PlainText,
      userDisplayName: PlainText,
      rpName: PlainText,
      creationDate: PasskeyCreationDate,
    }),
  ),
});
const decodePasskeys = Schema.decodeUnknownSync(plainPasskeys);

const transformPasskey = async (
  passkey: EncryptedPasskey,
  transform: (value: string) => Promise<string>,
): Promise<EncryptedPasskey> => {
  const optional = (value: string | null | undefined) =>
    value == null ? value : transform(value);
  const [
    credentialId,
    keyType,
    keyAlgorithm,
    keyCurve,
    keyValue,
    rpId,
    counter,
    discoverable,
    userHandle,
    userName,
    userDisplayName,
    rpName,
  ] = await Promise.all([
    transform(passkey.credentialId),
    transform(passkey.keyType),
    transform(passkey.keyAlgorithm),
    transform(passkey.keyCurve),
    transform(passkey.keyValue),
    transform(passkey.rpId),
    transform(passkey.counter),
    transform(passkey.discoverable),
    optional(passkey.userHandle),
    optional(passkey.userName),
    optional(passkey.userDisplayName),
    optional(passkey.rpName),
  ]);
  return {
    credentialId,
    keyType,
    keyAlgorithm,
    keyCurve,
    keyValue,
    rpId,
    counter,
    discoverable,
    ...(userHandle !== undefined && { userHandle }),
    ...(userName !== undefined && { userName }),
    ...(userDisplayName !== undefined && { userDisplayName }),
    ...(rpName !== undefined && { rpName }),
    creationDate: passkey.creationDate,
  };
};

const transformPasskeys = async (
  passkeys: readonly EncryptedPasskey[] | null | undefined,
  transform: (value: string) => Promise<string>,
) =>
  passkeys == null
    ? passkeys
    : Promise.all(
        passkeys.map((passkey) => transformPasskey(passkey, transform)),
      );

const failures = (index: number, reason: string) =>
  new Error(`Item ${index + 1} ${reason}.`);
const present = (value: unknown) =>
  value != null && (!Array.isArray(value) || value.length > 0);

const decodePortable = (raw: unknown): PortableVault => {
  if (
    !isObject(raw) ||
    !Array.isArray(raw.items) ||
    (raw.folders != null && !Array.isArray(raw.folders))
  )
    throw new Error("Choose a personal Bitwarden JSON export.");
  if (present(raw.collections) || present(raw.organizationId))
    throw new Error("The file contains shared vault data.");
  const rawFolders = raw.folders ?? [];
  if (
    raw.items.length > vaultImportItems ||
    rawFolders.length > vaultImportFolders
  )
    throw new Error(
      `Import up to ${vaultImportItems} items and ${vaultImportFolders} folders at a time.`,
    );
  const knownFolders = new Set<string>();
  const folders = rawFolders.map((folder, index) => {
    if (
      !isObject(folder) ||
      typeof folder.id !== "string" ||
      !folder.id ||
      knownFolders.has(folder.id) ||
      !Schema.is(requiredSmallText)(folder.name) ||
      !folder.name.trim()
    )
      throw new Error(`Folder ${index + 1} has an invalid name or ID.`);
    knownFolders.add(folder.id);
    return { id: folder.id, name: folder.name };
  });
  const items = raw.items.map(
    (rawItem, index): PortableVault["items"][number] => {
      if (!isObject(rawItem)) throw failures(index, "has an invalid structure");
      if (
        [
          "organizationId",
          "collectionIds",
          "attachments",
          "attachments2",
          "data",
          "key",
          "fido2Credentials",
        ].some((name) => present(rawItem[name]))
      )
        throw failures(
          index,
          "contains shared data, attachment references, encryption metadata, or passkeys",
        );
      const {
        type,
        name,
        id,
        folderId,
        archivedDate,
        deletedDate,
        ...details
      } = Schema.decodeUnknownSync(plainMetadata)(rawItem);
      if (!name.trim()) throw failures(index, "has an empty name");
      if (folderId != null && !knownFolders.has(folderId))
        throw failures(index, "references a missing folder");
      if (deletedDate != null) throw failures(index, "is in Trash");
      if (archivedDate != null && !Number.isFinite(Date.parse(archivedDate)))
        throw failures(index, "has an invalid archive date");
      const { wire, fields } = itemTypes[type];
      if (
        Object.values(itemTypes).some(
          (candidate) =>
            candidate.wire !== wire && rawItem[candidate.wire] != null,
        )
      )
        throw failures(index, "contains multiple item types");
      const payload = rawItem[wire];
      if (!isObject(payload))
        throw failures(index, "has no supported type data");
      if (type === 1) {
        const { uris, ...credentials } =
          Schema.decodeUnknownSync(plainLogin)(payload);
        let passkeys: typeof plainPasskeys.Type;
        try {
          passkeys = decodePasskeys(payload);
        } catch {
          throw failures(index, "contains an invalid passkey");
        }
        return {
          id: id ?? undefined,
          type,
          name,
          folderId: folderId ?? null,
          archivedDate,
          details: {
            ...details,
            credentials: {
              ...credentials,
              ...passkeys,
              uris: uris?.map(({ uri, match }) => ({
                uri: uri ?? null,
                match,
              })),
            },
          },
        };
      }
      if (details.passwordHistory?.length)
        throw failures(index, "has unsupported password history");
      if (type === 2 && payload.type !== 0)
        throw failures(index, "has an unsupported note type");
      const data =
        type === 2
          ? undefined
          : Object.fromEntries(
              Object.entries(payload).map(([key, value]) => {
                if (
                  !Object.hasOwn(fields, key) ||
                  !(typeof value === "string" || value === null)
                )
                  throw failures(index, "has unsupported type fields");
                return [key, value];
              }),
            );
      return {
        id: id ?? undefined,
        type,
        name,
        folderId: folderId ?? null,
        archivedDate,
        details: { ...details, data },
      };
    },
  );
  if (!items.length && !folders.length)
    throw new Error("The file contains no items or folders.");
  return { items, folders };
};

const encoder = new TextEncoder();
const isNumberWithin = (
  value: unknown,
  min: number,
  max: number,
): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;

const openProtectedExport = async (
  file: RecordValue,
  password: string,
  signal?: AbortSignal,
) => {
  if (file.passwordProtected !== true)
    throw new Error(
      "Account-restricted exports require the original Bitwarden account. Use a portable export.",
    );
  const {
    salt,
    kdfType,
    kdfIterations,
    kdfMemory,
    kdfParallelism,
    encKeyValidation_DO_NOT_EDIT: verifier,
    data,
  } = file;
  if (!password)
    throw new Error("Enter the password used to protect the export.");
  if (
    typeof salt !== "string" ||
    !/^[A-Za-z0-9+/]{22}==$/u.test(salt) ||
    typeof verifier !== "string" ||
    typeof data !== "string"
  )
    throw new Error("The password-protected export is invalid.");
  let key: VaultKey;
  if (kdfType === 0 && isNumberWithin(kdfIterations, 5_000, 2_000_000)) {
    key = await deriveMasterKey(password, salt, kdfIterations, "decrypt");
  } else if (
    kdfType === 1 &&
    isNumberWithin(kdfIterations, 2, 10) &&
    isNumberWithin(kdfMemory, 16, 128) &&
    isNumberWithin(kdfParallelism, 1, 16)
  ) {
    const { argon2idAsync } = await import("@noble/hashes/argon2.js");
    const saltHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(salt)),
    );
    const bytes = encoder.encode(password);
    const material = await argon2idAsync(bytes, saltHash, {
      t: kdfIterations,
      m: kdfMemory * 1024,
      p: kdfParallelism,
      dkLen: 32,
    }).finally(() => bytes.fill(0));
    const bytesForKey = new Uint8Array(material);
    try {
      signal?.throwIfAborted();
      key = await stretchVaultKey(bytesForKey, "decrypt");
    } finally {
      bytesForKey.fill(0);
      material.fill(0);
    }
  } else
    throw new Error("The export uses unsupported key derivation settings.");
  try {
    await decryptVaultText(verifier, key);
    return JSON.parse(await decryptVaultText(data, key)) as unknown;
  } catch {
    throw new Error("The file password is incorrect or the export is damaged.");
  }
};

export const readPortableVault = async (
  text: string,
  password = "",
  signal?: AbortSignal,
) => {
  const body = text.replace(/^\uFEFF/u, "").trim();
  let raw: unknown;
  if (body.startsWith("{")) {
    try {
      raw = JSON.parse(body);
    } catch {
      throw new Error("The Bitwarden JSON file is invalid.");
    }
    if (isObject(raw) && raw.encrypted === true)
      raw = await openProtectedExport(raw, password, signal);
  } else raw = readVaultCsv(body);
  try {
    return decodePortable(raw);
  } catch (cause) {
    if (Schema.isSchemaError(cause))
      throw new Error("An item contains invalid Bitwarden fields.");
    throw cause;
  }
};

const itemData = (type: ItemType, details: Details) => {
  if (type === 1) return { login: details.credentials ?? {} };
  if (type === 2) return { secureNote: { type: 0 } };
  return { [itemTypes[type].wire]: details.data ?? {} };
};

const wireVault = (vault: PortableVault) => ({
  encrypted: false,
  folders: vault.folders,
  items: vault.items.map(({ details, ...item }) => {
    const { credentials: _, data: __, ...metadata } = details;
    return { ...item, ...metadata, ...itemData(item.type, details) };
  }),
});

export const writePortableJson = (vault: PortableVault) =>
  JSON.stringify(wireVault(vault), null, 2);

export const writePortableCsv = (vault: PortableVault) => {
  const folderNames = new Map(vault.folders.map(({ id, name }) => [id, name]));
  return writeVaultCsv(
    vault.items.flatMap(({ details, type, folderId, name, archivedDate }) => {
      if (type !== 1 && type !== 2) return [];
      const login = details.credentials;
      return [
        {
          folder: folderId ? folderNames.get(folderId) : null,
          favorite: details.favorite ? 1 : null,
          type: type === 1 ? "login" : "note",
          name,
          notes: details.notes,
          fields: details.fields
            ?.map(({ name, value }) => `${name ?? ""}: ${value ?? ""}`)
            .join("\n"),
          reprompt: details.reprompt ?? 0,
          archivedDate,
          login_uri:
            login?.uris && csvExportUris(login.uris.map(({ uri }) => uri)),
          login_username: login?.username,
          login_password: login?.password,
          login_totp: login?.totp,
        },
      ];
    }),
  );
};

export const writeProtectedExport = async (
  vault: PortableVault,
  password: string,
) => {
  const salt = Base64.encode(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveMasterKey(
    password,
    salt,
    vaultKdfIterations,
    "encrypt",
  );
  return JSON.stringify(
    {
      encrypted: true,
      passwordProtected: true,
      salt,
      kdfType: 0,
      kdfIterations: vaultKdfIterations,
      encKeyValidation_DO_NOT_EDIT: await encryptVaultText(
        crypto.randomUUID(),
        key,
      ),
      data: await encryptVaultText(writePortableJson(vault), key),
    },
    null,
    2,
  );
};

export const openPortableVault = async (
  snapshot: typeof VaultSnapshot.Type,
  key: VaultKey,
  signal?: AbortSignal,
  includePasskeys = true,
): Promise<PortableVault> => {
  const folders = await Promise.all(
    snapshot.folders.map(async ({ id, name }) => ({
      id,
      name: await decryptVaultText(name, key),
    })),
  );
  const items: PortableVault["items"] = [];
  for (const item of snapshot.items) {
    signal?.throwIfAborted();
    const itemKey = await unwrapVaultKey(item.wrappedKey, key);
    const details = await decryptItemDetails(item.details, itemKey);
    const fido2Credentials = includePasskeys
      ? await transformPasskeys(
          item.details.credentials?.fido2Credentials,
          (value) => decryptVaultText(value, itemKey),
        )
      : undefined;
    const passwordHistory = await Promise.all(
      (item.details.passwordHistory ?? []).map(
        async ({ password, lastUsedDate }) => ({
          password:
            password == null ? null : await decryptVaultText(password, itemKey),
          lastUsedDate,
        }),
      ),
    );
    items.push({
      id: item.id,
      name: await decryptVaultText(item.name, itemKey),
      type: item.type,
      folderId: item.folderId,
      archivedDate:
        item.archivedAt === null
          ? null
          : new Date(item.archivedAt).toISOString(),
      details: {
        ...details,
        passwordHistory,
        ...(details.credentials &&
          fido2Credentials !== undefined && {
            credentials: { ...details.credentials, fido2Credentials },
          }),
      },
    });
  }
  return { folders, items };
};

export const sealPortableVault = async (
  vault: PortableVault,
  key: VaultKey,
  signal?: AbortSignal,
) => {
  const folderIndices = new Map(
    vault.folders.map(({ id }, index) => [id, index]),
  );
  const folders = await Promise.all(
    vault.folders.map(async ({ name }) => ({
      name: await encryptVaultText(name, key),
    })),
  );
  const folderRelationships = [];
  const ciphers = [];
  for (const [index, item] of vault.items.entries()) {
    signal?.throwIfAborted();
    const { type, name, details, folderId, archivedDate } = item;
    if (folderId !== null)
      folderRelationships.push({
        key: index,
        value: folderIndices.get(folderId)!,
      });
    const { wrappedKey, ...cipher } = await encryptNewItem(
      key,
      async (itemKey) => {
        const seal = (value: string | null | undefined) =>
          value == null
            ? Promise.resolve(null)
            : encryptVaultText(value, itemKey);
        const {
          credentials,
          data,
          fields,
          notes,
          passwordHistory,
          ...metadata
        } = details;
        const fido2Credentials = await transformPasskeys(
          credentials?.fido2Credentials,
          (value) => encryptVaultText(value, itemKey),
        );
        const encrypted: Details = {
          ...metadata,
          notes: await seal(notes),
          fields: await Promise.all(
            (fields ?? []).map(async (field) => ({
              ...field,
              name: await seal(field.name),
              value: await seal(field.value),
            })),
          ),
          passwordHistory: await Promise.all(
            (passwordHistory ?? []).map(async (entry) => ({
              ...entry,
              password: await seal(entry.password),
            })),
          ),
          ...(credentials && {
            credentials: {
              ...credentials,
              ...(fido2Credentials !== undefined && { fido2Credentials }),
              username: await seal(credentials.username),
              password: await seal(credentials.password),
              totp: await seal(credentials.totp),
              uris: await Promise.all(
                (credentials.uris ?? []).map(async ({ uri, match }) => ({
                  ...(uri == null
                    ? { uri: null }
                    : await encryptWebsite(uri, itemKey)),
                  match,
                })),
              ),
            },
          }),
          ...(data && {
            data: Object.fromEntries(
              await Promise.all(
                Object.entries(data).map(async ([field, value]) => [
                  field,
                  await seal(value),
                ]),
              ),
            ),
          }),
        };
        const { credentials: _, data: __, ...encryptedMetadata } = encrypted;
        return {
          type,
          archivedDate,
          name: await encryptVaultText(name, itemKey),
          ...encryptedMetadata,
          ...itemData(type, encrypted),
        };
      },
    );
    ciphers.push({ ...cipher, key: wrappedKey });
  }
  return { ciphers, folders, folderRelationships };
};
