import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { accounts } from "./database.ts";

export const mailboxes = sqliteTable("mailboxes", {
  id: text().primaryKey(),
  ownerAccountId: text("owner_account_id")
    .notNull()
    .references(() => accounts.id),
  name: text().notNull(),
});

export const mailboxAddresses = sqliteTable(
  "mailbox_addresses",
  {
    address: text().primaryKey(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id),
    canReceive: integer("can_receive").notNull().default(0),
    canSend: integer("can_send").notNull().default(0),
  },
  (table) => [index("mailbox_addresses_mailbox").on(table.mailboxId)],
);

// Catch-all delivery is separate from permission to send as an address.
export const mailDomainRoutes = sqliteTable("mail_domain_routes", {
  domain: text().primaryKey(),
  mailboxId: text("mailbox_id")
    .notNull()
    .references(() => mailboxes.id),
});
