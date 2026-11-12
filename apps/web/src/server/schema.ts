import { authTables } from "./database.ts";

export {
  accounts,
  cliLogins,
  cliTokens,
  extensionTokens,
  links,
} from "./database.ts";
export const {
  identifiers,
  credentials,
  sessions,
  pending,
  passwords,
  proofs,
} = authTables;
