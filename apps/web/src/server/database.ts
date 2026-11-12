import * as D1Client from "@effect/sql-d1/D1Client";
import { AuthPersistence } from "@yielded/auth-persistence-drizzle/D1";
import { Auth, Schema as AuthSchema } from "@yielded/auth";
import { Effect, Layer, type Redacted } from "effect";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
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

export const authDependencies = (
  db: D1Client.D1ClientConfig["db"],
  secret: Redacted.Redacted<string>,
) =>
  Layer.mergeAll(
    PersistenceLive.pipe(Layer.provide(D1Client.layer({ db }))),
    ClaimsLive,
    PasswordLive,
    OwnerPasswordPolicy,
    DisabledPasswordManagement,
    Auth.AuthConfig.layer({ secret }),
  ).pipe(Layer.provideMerge(CryptoLive));
