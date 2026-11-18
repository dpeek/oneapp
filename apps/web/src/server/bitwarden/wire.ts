import type { PersonalLogin, PersonalVault } from "../vault/personal.ts";
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

export const profile = (vault: PersonalVault, identity: GrantIdentity) => ({
  id: vault.id,
  name: identity.email,
  email: identity.email,
  emailVerified: identity.emailVerified === 1,
  premium: false,
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

export const cipher = (login: PersonalLogin) => ({
  id: login.id,
  type: 1,
  object: "cipherDetails",
  name: login.name,
  key: login.wrappedKey,
  creationDate: new Date(login.createdAt).toISOString(),
  revisionDate: new Date(login.revisionAt).toISOString(),
  deletedDate:
    login.deletedAt === null ? null : new Date(login.deletedAt).toISOString(),
  organizationId: null,
  folderId: null,
  notes: login.details.notes ?? null,
  favorite: login.details.favorite ?? false,
  // The client SDK requires a boolean when decrypting the update response.
  organizationUseTotp: false,
  edit: true,
  permissions: { delete: login.deletedAt === null, restore: true },
  viewPassword: true,
  collectionIds: [],
  reprompt: login.details.reprompt ?? 0,
  fields: login.details.fields ?? [],
  passwordHistory: login.details.passwordHistory ?? [],
  login: { ...login.details.credentials, fido2Credentials: [] },
});

export const sync = (
  vault: PersonalVault,
  identity: GrantIdentity,
  logins: PersonalLogin[],
) => ({
  profile: profile(vault, identity),
  ciphers: logins.map(cipher),
  folders: [],
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
