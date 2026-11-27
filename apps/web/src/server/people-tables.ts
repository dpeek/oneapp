import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { accounts } from "./database.ts";

export const people = sqliteTable("people", {
  id: text().primaryKey(),
  accountId: text("account_id")
    .unique()
    .references(() => accounts.id),
  name: text().notNull().default(""),
  kind: text({ enum: ["person", "company"] })
    .notNull()
    .default("person"),
  photo: text(),
  avatarStyle: text("avatar_style", { enum: ["website", "fit", "fill"] }),
  revision: text().notNull(),
});

export const personAddresses = sqliteTable(
  "person_addresses",
  {
    email: text().primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
  },
  (table) => [index("person_addresses_person").on(table.personId)],
);

export const companyDomains = sqliteTable(
  "company_domains",
  {
    domain: text().primaryKey(),
    companyId: text("company_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    position: integer().notNull().default(0),
  },
  (table) => [index("company_domains_company").on(table.companyId)],
);

export const contactDeletions = sqliteTable(
  "contact_deletions",
  {
    id: text().primaryKey(),
    receipt: text().notNull().unique(),
    revision: text().notNull(),
    name: text().notNull(),
    kind: text({ enum: ["person", "company"] }).notNull(),
    photo: text(),
    avatarStyle: text("avatar_style", { enum: ["website", "fit", "fill"] }),
    addresses: text().notNull(),
    domains: text().notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("contact_deletions_expiry").on(table.expiresAt)],
);
