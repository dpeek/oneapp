import type { AttachmentMetadata } from "../../vault-attachment-contract.ts";
import { itemTypes } from "../../vault-item-content.ts";
import type { PersonalFolder } from "../vault/folders.ts";
import type { PersonalItem, PersonalVault } from "../vault/personal.ts";
import type { GrantIdentity } from "./tokens.ts";

const accountKeys = (vault: PersonalVault) => ({
  publicKeyEncryptionKeyPair: {
    wrappedPrivateKey: vault.wrappedPrivateKey,
    publicKey: vault.publicKey,
    signedPublicKey: null,
    object: "publicKeyEncryptionKeyPair",
  },
  securityState: null,
  signatureKeyPair: null,
  object: "privateKeys",
});

export const attachment = (record: AttachmentMetadata, url = "") => ({
  object: "attachment",
  id: record.id,
  fileName: record.name,
  key: record.wrappedKey,
  size: String(record.size),
  sizeName:
    record.size < 1024
      ? `${record.size} B`
      : `${Math.round(record.size / 1024)} KB`,
  url,
});
export const profile = (
  vault: PersonalVault,
  identity: GrantIdentity,
  hasFiles: boolean,
) => ({
  id: vault.id,
  name: identity.email,
  email: identity.email,
  emailVerified: identity.emailVerified === 1,
  premium: hasFiles,
  culture: "en-US",
  twoFactorEnabled: false,
  key: vault.wrappedKey,
  privateKey: vault.wrappedPrivateKey,
  accountKeys: accountKeys(vault),
  organizations: [],
  organizationsNew: [],
  providers: [],
  providerOrganizations: [],
  forcePasswordReset: false,
  usesKeyConnector: false,
  creationDate: new Date(vault.createdAt).toISOString(),
  object: "profile",
});

export const keys = (vault: PersonalVault) => ({
  key: vault.wrappedKey,
  privateKey: vault.wrappedPrivateKey,
  publicKey: vault.publicKey,
  accountKeys: accountKeys(vault),
  object: "keys",
});

export const unlockOptions = (vault: PersonalVault) => ({
  Key: vault.wrappedKey,
  PrivateKey: vault.wrappedPrivateKey,
  AccountKeys: accountKeys(vault),
  Kdf: 0,
  KdfIterations: vault.kdfIterations,
  ForcePasswordReset: false,
  UserDecryptionOptions: {
    HasMasterPassword: true,
    MasterPasswordUnlock: {
      Kdf: { KdfType: 0, Iterations: vault.kdfIterations },
      Salt: vault.kdfSalt,
      ContainedKeyId: vault.keyId,
      MasterKeyEncryptedUserKey: vault.wrappedKey,
      MasterKeyWrappedUserKey: vault.wrappedKey,
    },
    Object: "userDecryptionOptions",
  },
});

export const cipher = (item: PersonalItem) => ({
  id: item.id,
  type: item.type,
  object: "cipherDetails",
  name: item.name,
  key: item.wrappedKey,
  creationDate: new Date(item.createdAt).toISOString(),
  revisionDate: new Date(item.revisionAt).toISOString(),
  deletedDate:
    item.deletedAt === null ? null : new Date(item.deletedAt).toISOString(),
  organizationId: null,
  folderId: item.folderId,
  archivedDate:
    item.archivedAt === null ? null : new Date(item.archivedAt).toISOString(),
  notes: item.details.notes ?? null,
  favorite: item.details.favorite ?? false,
  // The client SDK requires a boolean when decrypting the update response.
  organizationUseTotp: false,
  edit: true,
  permissions: { delete: item.deletedAt === null, restore: true },
  viewPassword: true,
  collectionIds: [],
  reprompt: item.details.reprompt ?? 0,
  fields: item.details.fields ?? [],
  attachments: item.attachments.map((record) => attachment(record)),
  ...(item.type === 1
    ? {
        passwordHistory: item.details.passwordHistory ?? [],
        login: { ...item.details.credentials, fido2Credentials: [] },
      }
    : item.type === 2
      ? { secureNote: { type: 0 } }
      : { [itemTypes[item.type].wire]: item.details.data }),
});

export const folder = (record: PersonalFolder) => ({
  id: record.id,
  name: record.name,
  revisionDate: new Date(record.revisionAt).toISOString(),
  object: "folder",
});
export const list = <A>(data: A[]) => ({
  object: "list",
  data,
  continuationToken: null,
});

export const sync = (
  vault: PersonalVault,
  identity: GrantIdentity,
  items: PersonalItem[],
  folders: PersonalFolder[],
  hasFiles: boolean,
) => ({
  profile: profile(vault, identity, hasFiles),
  ciphers: items.map(cipher),
  folders: folders.map(folder),
  collections: [],
  policies: [],
  policiesNew: [],
  sends: [],
  domains: null,
  userDecryption: {
    userKeyId: vault.keyId,
    masterPasswordUnlock: {
      kdf: {
        kdfType: 0,
        iterations: vault.kdfIterations,
        memory: null,
        parallelism: null,
      },
      salt: vault.kdfSalt,
      containedKeyId: vault.keyId,
      masterKeyEncryptedUserKey: vault.wrappedKey,
      masterKeyWrappedUserKey: vault.wrappedKey,
    },
  },
  object: "sync",
});

export const config = (origin: string) => ({
  version: "2026.6.0",
  server: { name: "OneApp", url: origin },
  settings: {
    disableUserRegistration: true,
    suppressOnboardingInterstitials: true,
  },
  environment: {
    vault: origin,
    api: `${origin}/api`,
    identity: `${origin}/identity`,
    notifications: `${origin}/notifications`,
    sso: "",
  },
  push: { pushTechnology: 0, vapidPublicKey: null },
  featureStates: {},
  object: "config",
});
