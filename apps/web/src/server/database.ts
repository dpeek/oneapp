import * as D1Client from "@effect/sql-d1/D1Client";
import { AuthPersistence } from "@yielded/auth-persistence-drizzle/D1";
import { Auth, Schema as AuthSchema } from "@yielded/auth";
import { Effect, Layer, type Redacted } from "effect";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  AppAuth,
  ClaimsLive,
  CryptoLive,
  DisabledPasswordManagement,
  ownerId,
  OwnerPasswordPolicy,
  PasswordLive,
  passwordRequirement,
} from "./auth.ts";

export const accounts = sqliteTable("accounts", {
  id: text().primaryKey(),
  active: integer({ mode: "boolean" }).notNull(),
  securityRevision: text("security_revision").notNull(),
});

export const cliTokens = sqliteTable(
  "cli_tokens",
  {
    id: text().primaryKey().notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => accounts.id),
    label: text().notNull(),
    digest: text().notNull().unique(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
  },
  (table) => [
    index("cli_tokens_owner_created_at").on(table.ownerId, table.createdAt),
  ],
);

export const cliLogins = sqliteTable(
  "cli_logins",
  {
    id: text().primaryKey().notNull(),
    digest: text().notNull().unique(),
    code: text().notNull(),
    label: text().notNull(),
    expiresAt: integer("expires_at").notNull(),
    ownerId: text("owner_id").references(() => accounts.id),
    deniedAt: integer("denied_at"),
    redeemedAt: integer("redeemed_at"),
  },
  (table) => [index("cli_logins_expires_at").on(table.expiresAt)],
);

export const extensionTokens = sqliteTable(
  "extension_tokens",
  {
    id: text().primaryKey().notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => accounts.id),
    digest: text().notNull().unique(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
  },
  (table) => [index("extension_tokens_owner").on(table.ownerId)],
);

export const links = sqliteTable(
  "links",
  {
    id: text().primaryKey().notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => accounts.id),
    url: text().notNull(),
    savedAt: integer("saved_at").notNull(),
  },
  (table) => [
    index("links_owner_saved_at").on(table.ownerId, table.savedAt, table.id),
  ],
);

const Persistence = AuthPersistence.make(AppAuth);

const storage = Persistence.managed({
  prefix: "oneapp_auth",
  subjects: {
    table: accounts,
    id: "id",
    status: "active",
    activeValue: true,
    securityRevision: "securityRevision",
    idCodec: AuthSchema.SubjectId,
    requirements: () => Effect.succeed(passwordRequirement),
  },
});

export const authTables = storage.schema;

const PersistenceLive = Persistence.layer.pipe(
  Layer.provide(Persistence.Config.layer(storage)),
  Layer.provide(
    Layer.succeed(Persistence.Provisioning, {
      password: {
        values: () =>
          Effect.succeed({ id: ownerId, active: true, securityRevision: "1" }),
      },
    }),
  ),
);

export const databaseLayer = (db: D1Client.D1ClientConfig["db"]) =>
  D1Client.layer({ db });

export const authDependencies = (
  database: ReturnType<typeof databaseLayer>,
  secret: Redacted.Redacted<string>,
) =>
  Layer.mergeAll(
    PersistenceLive.pipe(Layer.provide(database)),
    ClaimsLive,
    PasswordLive,
    OwnerPasswordPolicy,
    DisabledPasswordManagement,
    Auth.AuthConfig.layer({ secret }),
  ).pipe(Layer.provideMerge(CryptoLive));
