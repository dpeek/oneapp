import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { accounts } from "./database.ts";

export const people = sqliteTable("people", {
  id: text().primaryKey(),
  accountId: text("account_id")
    .unique()
    .references(() => accounts.id),
  name: text().notNull().default(""),
  photo: text(),
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
