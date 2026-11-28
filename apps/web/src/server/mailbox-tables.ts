import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { accounts } from "./database.ts";

export const mailboxes = sqliteTable(
  "mailboxes",
  {
    id: text().primaryKey(),
    ownerAccountId: text("owner_account_id")
      .notNull()
      .references(() => accounts.id),
    name: text().notNull(),
  },
  (table) => [
    uniqueIndex("mailboxes_id_owner").on(table.id, table.ownerAccountId),
  ],
);

export const mailboxAddresses = sqliteTable(
  "mailbox_addresses",
  {
    address: text().primaryKey(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id),
    // Kept for the previously deployed Worker while it shares this database.
    canReceive: integer("can_receive").notNull().default(0),
    canSend: integer("can_send").notNull().default(0),
  },
  (table) => [index("mailbox_addresses_mailbox").on(table.mailboxId)],
);

export const mailInboundRoutes = sqliteTable(
  "mail_inbound_routes",
  {
    address: text().primaryKey(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id),
    enabled: integer({ mode: "boolean" }).notNull(),
  },
  (table) => [index("mail_inbound_routes_mailbox").on(table.mailboxId)],
);

// Retained during the Worker rollout so the previous version can still
// resolve an unknown recipient. The migration empties this table.
export const mailDomainRoutes = sqliteTable("mail_domain_routes", {
  domain: text().primaryKey(),
  mailboxId: text("mailbox_id")
    .notNull()
    .references(() => mailboxes.id),
});
