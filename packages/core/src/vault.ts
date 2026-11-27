import { Schema } from "effect";

// Personal vaults currently use Bitwarden's authenticated type-2 encrypted strings.
export const EncryptedVaultValue = Schema.String.check(
  Schema.isMaxLength(128 * 1024),
  Schema.isPattern(
    /^2\.[A-Za-z0-9+/]{22}==\|[A-Za-z0-9+/]{22,}={0,2}\|[A-Za-z0-9+/]{43}=$/u,
  ),
);

export const WrappedItemKey = Schema.String.check(
  Schema.isPattern(
    /^2\.[A-Za-z0-9+/]{22}==\|[A-Za-z0-9+/]{107}=\|[A-Za-z0-9+/]{43}=$/u,
  ),
);

export const vaultKdfIterations = 600_000;
export const hostUriMatch = 1;

const optionalEncrypted = Schema.optionalKey(
  Schema.NullOr(EncryptedVaultValue),
);
export const EncryptedLoginUri = Schema.Struct({
  uri: Schema.NullOr(EncryptedVaultValue),
  match: Schema.optionalKey(Schema.NullOr(Schema.Literals([0, 1, 2, 3, 4, 5]))),
  uriChecksum: optionalEncrypted,
});

export const extensionVaultPath = "/api/extension-vault";
export const ExtensionVaultLogin = Schema.Struct({
  id: Schema.String,
  name: EncryptedVaultValue,
  wrappedKey: WrappedItemKey,
  revision: Schema.Int,
  username: Schema.NullOr(EncryptedVaultValue),
  password: Schema.NullOr(EncryptedVaultValue),
  uris: Schema.Array(EncryptedLoginUri),
  requiresMasterPassword: Schema.Boolean,
});
export type ExtensionVaultLogin = typeof ExtensionVaultLogin.Type;

export const ExtensionVaultSnapshot = Schema.Struct({
  keyId: Schema.String,
  wrappedKey: WrappedItemKey,
  kdfSalt: Schema.NonEmptyString,
  kdfIterations: Schema.Int.check(Schema.isGreaterThan(0)),
  logins: Schema.Array(ExtensionVaultLogin),
});
export type ExtensionVaultSnapshot = typeof ExtensionVaultSnapshot.Type;
