import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { personalVaults } from "../vault/tables.ts";

export const bitwardenAuthorizations = sqliteTable(
  "bitwarden_authorizations",
  {
    id: text().primaryKey(),
    vaultId: text("vault_id")
      .notNull()
      .references(() => personalVaults.id, { onDelete: "cascade" }),
    browserSessionId: text("browser_session_id").notNull(),
    securityRevision: text("security_revision").notNull(),
    consentDigest: text("consent_digest").unique(),
    codeDigest: text("code_digest").unique(),
    state: text().notNull(),
    challenge: text().notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("bitwarden_authorizations_expiry").on(table.expiresAt)],
);

export const bitwardenDeviceSessions = sqliteTable(
  "bitwarden_device_sessions",
  {
    id: text().primaryKey(),
    vaultId: text("vault_id")
      .notNull()
      .references(() => personalVaults.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    securityRevision: text("security_revision").notNull(),
    email: text().notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
    expiresAt: integer("expires_at").notNull(),
    generation: integer().notNull(),
    issuedAt: integer("issued_at").notNull(),
    accessDigest: text("access_digest").notNull().unique(),
    refreshDigest: text("refresh_digest").notNull().unique(),
    previousAccessDigest: text("previous_access_digest").unique(),
    previousRefreshDigest: text("previous_refresh_digest").unique(),
    retryUntil: integer("retry_until"),
  },
  (table) => [index("bitwarden_device_sessions_expiry").on(table.expiresAt)],
);
