import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { ItemContent } from "../../vault-item-content.ts";
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

// Keep the physical table name so the active Worker can continue using it during migration.
export const personalVaultItems = sqliteTable(
  "personal_vault_logins",
  {
    id: text().primaryKey(),
    vaultId: text("vault_id")
      .notNull()
      .references(() => personalVaults.id, { onDelete: "cascade" }),
    name: text().notNull(),
    wrappedKey: text("wrapped_key").notNull(),
    details: text({ mode: "json" }).$type<ItemContent["details"]>().notNull(),
    createDigest: text("create_digest"),
    createdAt: integer("created_at").notNull(),
    revisionAt: integer("revision_at").notNull(),
    deletedAt: integer("deleted_at"),
    archivedAt: integer("archived_at"),
    folderId: text("folder_id").references(() => personalVaultFolders.id, {
      onDelete: "set null",
    }),
    type: integer().$type<ItemContent["type"]>().notNull().default(1),
  },
  (table) => [
    index("personal_vault_logins_vault").on(table.vaultId),
    uniqueIndex("personal_vault_logins_create").on(
      table.vaultId,
      table.createDigest,
    ),
  ],
);

export const personalVaultFolders = sqliteTable(
  "personal_vault_folders",
  {
    id: text().primaryKey(),
    vaultId: text("vault_id")
      .notNull()
      .references(() => personalVaults.id, { onDelete: "cascade" }),
    name: text().notNull(),
    revisionAt: integer("revision_at").notNull(),
    createDigest: text("create_digest"),
  },
  (table) => [
    uniqueIndex("personal_vault_folder_create").on(
      table.vaultId,
      table.createDigest,
    ),
  ],
);

export const personalVaultDeletedItems = sqliteTable(
  "personal_vault_deleted_items",
  {
    id: text().primaryKey(),
    vaultId: text("vault_id")
      .notNull()
      .references(() => personalVaults.id, { onDelete: "cascade" }),
  },
);

export const personalVaultImports = sqliteTable(
  "personal_vault_imports",
  {
    id: text().primaryKey(),
    vaultId: text("vault_id")
      .notNull()
      .references(() => personalVaults.id, { onDelete: "cascade" }),
    digest: text().notNull(),
  },
  (table) => [
    uniqueIndex("personal_vault_import_digest").on(table.vaultId, table.digest),
  ],
);

export const personalVaultAttachments = sqliteTable(
  "personal_vault_attachments",
  {
    id: text().primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => personalVaultItems.id, { onDelete: "cascade" }),
    name: text().notNull(),
    wrappedKey: text("wrapped_key").notNull(),
    size: integer().notNull(),
    itemKey: text("item_key").notNull(),
    revisionAt: integer("revision_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    readyAt: integer("ready_at"),
    createDigest: text("create_digest").notNull(),
  },
  (table) => [
    uniqueIndex("personal_vault_attachment_create").on(
      table.itemId,
      table.createDigest,
    ),
  ],
);

export const personalVaultAttachmentCleanup = sqliteTable(
  "personal_vault_attachment_cleanup",
  {
    id: text().primaryKey(),
    deleteAfter: integer("delete_after").notNull(),
  },
);
