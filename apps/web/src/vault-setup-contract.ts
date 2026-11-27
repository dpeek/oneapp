import { Schema } from "effect";

export const vaultPath = "/vault";
export const vaultSetupPath = "/api/vault/setup";
export { vaultKdfIterations } from "@orumai/core/vault";
export const vaultPasswordMinimum = 12;
export const vaultPasswordMaximum = 1024;
export const normalizeVaultSalt = (email: string) => email.trim().toLowerCase();

const Salt = Schema.NonEmptyString.check(Schema.isMaxLength(320));
const base64 = "[A-Za-z0-9+/]";
const iv = `${base64}{22}==`;
const mac = `${base64}{43}=`;

export const VaultSetup = Schema.Struct({
  kdfSalt: Salt,
  wrappedKey: Schema.String.check(
    Schema.isPattern(new RegExp(`^2\\.${iv}\\|${base64}{107}=\\|${mac}$`, "u")),
  ),
  keyId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)),
  wrappedPrivateKey: Schema.String.check(
    Schema.isMaxLength(4096),
    Schema.isPattern(
      new RegExp(`^2\\.${iv}\\|${base64}{1500,4000}={0,2}\\|${mac}$`, "u"),
    ),
  ),
  publicKey: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9+/]{390,400}={0,2}$/u),
  ),
});

export const VaultSetupStatus = Schema.Union([
  Schema.Struct({ initialized: Schema.Literal(false), kdfSalt: Salt }),
  Schema.Struct({ initialized: Schema.Literal(true) }),
]);
