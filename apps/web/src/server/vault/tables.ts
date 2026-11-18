import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { LoginDetails } from "./login.ts";
import { accounts } from "../database.ts";

export const personalVaults = sqliteTable("personal_vaults", {
  id: text().primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .unique()
    .references(() => accounts.id, { onDelete: "cascade" }),
  kdfSalt: text("kdf_salt").notNull(),
  kdfIterations: integer("kdf_iterations").notNull(),
  wrappedKey: text("wrapped_key").notNull(),
  keyId: text("key_id").notNull(),
  wrappedPrivateKey: text("wrapped_private_key").notNull(),
  publicKey: text("public_key").notNull(),
  createdAt: integer("created_at").notNull(),
  revisionAt: integer("revision_at").notNull(),
});

export const personalVaultLogins = sqliteTable(
  "personal_vault_logins",
  {
    id: text().primaryKey(),
    vaultId: text("vault_id")
      .notNull()
      .references(() => personalVaults.id, { onDelete: "cascade" }),
    name: text().notNull(),
    wrappedKey: text("wrapped_key").notNull(),
    details: text({ mode: "json" }).$type<LoginDetails>().notNull(),
    createDigest: text("create_digest"),
    createdAt: integer("created_at").notNull(),
    revisionAt: integer("revision_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("personal_vault_logins_vault").on(table.vaultId),
    uniqueIndex("personal_vault_logins_create").on(
      table.vaultId,
      table.createDigest,
    ),
  ],
);
