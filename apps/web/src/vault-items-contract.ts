import { Schema } from "effect";
import { VaultSetup } from "./vault-setup-contract.ts";

export const vaultItemsPath = "/api/vault/items";
export const vaultItemPath = (id: string) => `${vaultItemsPath}/${id}`;
export const VaultLifecycleAction = Schema.Literals(["trash", "restore"]);
export type VaultLifecycleAction = typeof VaultLifecycleAction.Type;
export const vaultLifecyclePath = (id: string, action: VaultLifecycleAction) =>
  `${vaultItemPath(id)}/${action}`;
export const vaultItemBodyLimit = 128 * 1024;
export const VaultItemId = Schema.String.check(Schema.isUUID());

// Personal vaults currently use Bitwarden's authenticated type-2 encrypted strings.
export const EncryptedVaultValue = Schema.String.check(
  Schema.isMaxLength(vaultItemBodyLimit),
  Schema.isPattern(
    /^2\.[A-Za-z0-9+/]{22}==\|[A-Za-z0-9+/]{22,}={0,2}\|[A-Za-z0-9+/]{43}=$/u,
  ),
);

export const WrappedItemKey = Schema.String.check(
  Schema.isPattern(
    /^2\.[A-Za-z0-9+/]{22}==\|[A-Za-z0-9+/]{107}=\|[A-Za-z0-9+/]{43}=$/u,
  ),
);

const encryptedItem = {
  keyId: VaultSetup.fields.keyId,
  name: EncryptedVaultValue,
  wrappedKey: WrappedItemKey,
};
const ItemRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const VaultLifecycleChange = Schema.Struct({
  keyId: encryptedItem.keyId,
  expectedRevision: ItemRevision,
});

const CreateVaultNote = Schema.Struct({
  ...encryptedItem,
  type: Schema.optionalKey(Schema.Literal(2)),
  notes: Schema.NullOr(EncryptedVaultValue),
});
const encryptedLogin = {
  username: Schema.NullOr(EncryptedVaultValue),
  password: Schema.NullOr(EncryptedVaultValue),
};
const EncryptedWebsite = Schema.NullOr(
  Schema.Struct({
    uri: EncryptedVaultValue,
    uriChecksum: EncryptedVaultValue,
  }),
);
const CreateVaultLogin = Schema.Struct({
  ...encryptedItem,
  ...encryptedLogin,
  type: Schema.Literal(1),
  website: EncryptedWebsite,
});
export const CreateVaultItem = Schema.Union([
  CreateVaultLogin,
  CreateVaultNote,
]);

const editItem = {
  keyId: encryptedItem.keyId,
  name: EncryptedVaultValue,
  expectedRevision: ItemRevision,
};
const EditVaultNote = Schema.Struct({
  ...editItem,
  type: Schema.optionalKey(Schema.Literal(2)),
  notes: Schema.NullOr(EncryptedVaultValue),
});
export const EditVaultLogin = Schema.Struct({
  ...editItem,
  ...encryptedLogin,
  type: Schema.Literal(1),
  website: Schema.optionalKey(
    Schema.Struct({
      previousUri: Schema.NullOr(EncryptedVaultValue),
      replacement: EncryptedWebsite,
    }),
  ),
});
export const EditVaultItem = Schema.Union([EditVaultLogin, EditVaultNote]);
export const hostUriMatch = 1;

const itemFields = {
  id: Schema.String,
  name: Schema.String,
  wrappedKey: Schema.String,
  notes: Schema.NullOr(Schema.String),
  requiresMasterPassword: Schema.Boolean,
  revision: ItemRevision,
};

export const VaultSecureNote = Schema.Struct({
  ...itemFields,
  type: Schema.Literal(2),
});

export const VaultLogin = Schema.Struct({
  ...itemFields,
  type: Schema.Literal(1),
  username: Schema.NullOr(Schema.String),
  password: Schema.NullOr(Schema.String),
  uris: Schema.Array(Schema.String),
});
export const VaultItem = Schema.Union([VaultLogin, VaultSecureNote]);

export const VaultSnapshot = Schema.Struct({
  keyId: VaultSetup.fields.keyId,
  wrappedKey: Schema.String,
  kdfSalt: Schema.String,
  kdfIterations: Schema.Int.check(Schema.isGreaterThan(0)),
  items: Schema.Array(VaultItem),
  trash: Schema.Array(VaultItem),
});
