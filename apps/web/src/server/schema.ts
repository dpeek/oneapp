export {
  mailboxes,
  mailboxAddresses,
  mailDomainRoutes,
} from "./mailbox-tables.ts";
import { authTables } from "./database.ts";
export { pushSubscriptions, mailPushOutbox } from "./push-tables.ts";
export {
  mailImports,
  mailImportCompletions,
  mailImportRuns,
} from "./mail-import-tables.ts";
export {
  people,
  personAddresses,
  companyDomains,
  contactDeletions,
} from "./people-tables.ts";
export {
  mailChanges,
  mailConversations,
  mailIndexKeys,
  mailIndexMessages,
  mailIndexScans,
  mailSenderRules,
  mailSenderAvatars,
  mailSendRequests,
} from "./mail-tables.ts";

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

export {
  calendars,
  calendarEvents,
  calendarMovedUids,
  calendarPushOutbox,
} from "./calendar-tables.ts";
export { items, itemTags, tags } from "./item-tables.ts";
export {
  deletedTaskAttachments,
  tasks,
  taskAttachments,
  taskChanges,
  taskRuns,
} from "./task-tables.ts";
export { fileChanges, files } from "./file-tables.ts";
