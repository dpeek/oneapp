import type { D1Database } from "@cloudflare/workers-types";
import { mailDomains } from "../mail-settings-contract.ts";
import { ensureDefaultMailbox } from "./mailbox.ts";

export const [primaryMailDomain, orumaiMailDomain, winterpeekMailDomain] =
  mailDomains;
export const primaryMailAddress = `mail@${primaryMailDomain}`;

export const initialMailAliases = [
  `support@${orumaiMailDomain}`,
  `team@${orumaiMailDomain}`,
  `admin@${orumaiMailDomain}`,
  `david@${winterpeekMailDomain}`,
].join(",");

export const seedMailRoutes = (db: D1Database, aliases = initialMailAliases) =>
  ensureDefaultMailbox(db, primaryMailAddress, primaryMailAddress, aliases);
