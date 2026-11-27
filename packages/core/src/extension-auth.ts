import { Schema } from "effect";
import { Hex } from "effect/encoding";

export const extensionId = "nbcieagefnhllcdacdgpddokcdcnllee";
export const extensionAccessPath = "/api/extension-access";
export const currentExtensionPath = `${extensionAccessPath}/current`;
export const extensionApprovalHash = "#connect-extension=";
export const vaultExtensionApprovalHash = "#connect-vault-extension=";
export const ExtensionScope = Schema.Literals(["links", "vault-read"]);
export type ExtensionScope = typeof ExtensionScope.Type;

export const ExtensionRequestId = Schema.String.check(Schema.isUUID(4));
export const ExtensionSecret = Schema.String.check(
  Schema.isPattern(/^one_ext_[A-Za-z0-9_-]{43}$/u),
);
export const ExtensionApproval = Schema.Struct({
  id: ExtensionRequestId,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  scope: Schema.optionalKey(ExtensionScope),
});
export const ExtensionAccess = Schema.Struct({
  id: ExtensionRequestId,
  createdAt: Schema.Int,
  expiresAt: Schema.NullOr(Schema.Int),
  scope: ExtensionScope,
});
export const ExtensionAccessList = Schema.Array(ExtensionAccess);

export const digestSecret = async (secret: string) =>
  Hex.encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
    ),
  );
