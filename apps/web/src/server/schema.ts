import { authTables } from "./database.ts";

export {
  accountEmailChanges,
  accounts,
  cliLogins,
  cliTokens,
  extensionTokens,
  links,
  oauthAssertions,
  oauthGrants,
} from "./database.ts";
export const {
  identifiers,
  credentials,
  sessions,
  pending,
  passwords,
  proofs,
  emailCredentials,
} = authTables;
export {
  bitwardenAuthorizations,
  bitwardenDeviceSessions,
} from "./bitwarden/tables.ts";
export {
  personalVaultAttachmentCleanup,
  personalVaultAttachments,
  personalVaultDeletedItems,
  personalVaultFolders,
  personalVaultImports,
  personalVaultItems,
  personalVaults,
} from "./vault/tables.ts";
