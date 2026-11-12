import { accounts, authTables } from "./database.ts";

export { accounts };
export const {
  identifiers,
  credentials,
  sessions,
  pending,
  passwords,
  proofs,
} = authTables;
