import * as D1Client from "@effect/sql-d1/D1Client";
import { AuthPersistence } from "@yielded/auth-persistence-drizzle/D1";
import {
  Auth,
  EmailDelivery,
  Password,
  Schema as AuthSchema,
} from "@yielded/auth";
import { ProofDispatchScheduler, ProofKeys } from "@yielded/auth/Proofs";
import { Effect, Layer, Redacted } from "effect";
import { Base64Url } from "effect/encoding";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { ThemePreference } from "../account-contract.ts";
import {
  AppAuth,
  AccountActionEvidence,
  ClaimsLive,
  CryptoLive,
  ownerId,
  PasswordLive,
  passwordRequirement,
  passwordRecoveryRequirement,
} from "./auth.ts";

export const accounts = sqliteTable("accounts", {
  id: text().primaryKey(),
  active: integer({ mode: "boolean" }).notNull(),
  securityRevision: text("security_revision").notNull(),
  theme: text({ enum: ThemePreference.literals }).notNull().default("system"),
});

export const accountEmailChanges = sqliteTable("account_email_changes", {
  subjectId: text("subject_id")
    .primaryKey()
    .notNull()
    .references(() => accounts.id),
  id: text().notNull(),
  sessionId: text("session_id").notNull(),
  securityRevision: text("security_revision").notNull(),
  newEmail: text("new_email").notNull(),
  digest: text().notNull(),
  expiresAt: integer("expires_at").notNull(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
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
    scopes: text().notNull().default("[]"),
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
    scopes: text(),
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
    scope: text().$type<"links" | "vault-read">().notNull().default("links"),
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

export const oauthGrants = sqliteTable(
  "yielded_oauth_server",
  {
    namespace: text().notNull(),
    grantId: text("grant_id").notNull(),
    version: text().notNull(),
    revoked: integer().notNull().default(0),
    expiresAt: integer("expires_at_millis").notNull(),
    payload: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.namespace, table.grantId] })],
);

export const oauthAssertions = sqliteTable(
  "yielded_oauth_client_assertion",
  {
    namespace: text().notNull(),
    assertionId: text("assertion_id").notNull(),
    expiresAt: integer("expires_at_millis").notNull(),
  },
  (table) => [primaryKey({ columns: [table.namespace, table.assertionId] })],
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
    actionRequirements: (_, action) =>
      Effect.succeed(
        action === "reset-password"
          ? passwordRecoveryRequirement
          : passwordRequirement,
      ),
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

const accountVerificationKeys = (secret: Redacted.Redacted<string>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const encoder = new TextEncoder();
      const key = yield* Effect.promise(() =>
        crypto.subtle.importKey(
          "raw",
          encoder.encode(Redacted.value(secret)),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        ),
      );
      const derive = (label: string) =>
        Effect.promise(() =>
          crypto.subtle.sign("HMAC", key, encoder.encode(label)),
        ).pipe(
          Effect.map((bytes) => ({
            activeKeyId: "v1",
            keys: [
              {
                id: "v1",
                material: Redacted.make(
                  Base64Url.encode(new Uint8Array(bytes)),
                ),
              },
            ],
          })),
        );
      const proofKeys = yield* derive("oneapp/account-email/proof/v1");
      const bindingKeys = yield* derive(
        "oneapp/account-email/browser-binding/v1",
      );
      return Layer.merge(
        ProofKeys.layer(proofKeys),
        Auth.RequestBindingConfig.layer({
          keyring: bindingKeys,
          lifetimeMillis: 360_000,
          generation: 1,
        }),
      );
    }),
  );

export const authDependencies = (
  database: ReturnType<typeof databaseLayer>,
  secret: Redacted.Redacted<string>,
  passwordPolicy: Layer.Layer<Password.CompromisedPasswords>,
  emailDelivery: EmailDelivery.EmailDelivery["Service"],
  proofDelivery = ProofDispatchScheduler.layerInline,
) =>
  Layer.mergeAll(
    PersistenceLive.pipe(Layer.provide(database)),
    ClaimsLive,
    PasswordLive,
    passwordPolicy,
    AccountActionEvidence,
    proofDelivery,
    accountVerificationKeys(secret),
    Layer.succeed(EmailDelivery.EmailDelivery, emailDelivery),
    Auth.AuthConfig.layer({ secret }),
  ).pipe(Layer.provideMerge(CryptoLive));
