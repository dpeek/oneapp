import * as Cloudflare from "@alchemy.run/cloudflare";
import { Auth, Password, Schema as AuthSchema } from "@yielded/auth";
import * as Alchemy from "alchemy";
import { Config, Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { AppAuth, ownerId } from "./auth.ts";
import { disabledEmail } from "./account-email.ts";
import { authDependencies, databaseLayer } from "./database.ts";
import { BootstrapPasswordPolicy } from "./password-policy.ts";

const ownerState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [account] = yield* sql<{
    active: number;
    emails: number;
    passwords: number;
  }>`
    SELECT a.active, (
      SELECT count(*) FROM oneapp_auth_identifiers
      WHERE subject_id = a.id AND namespace = 'email' AND active = 1
    ) AS emails, (
      SELECT count(*) FROM oneapp_auth_passwords p JOIN oneapp_auth_credentials c
        ON c.subject_id = p.subject_id AND c.credential_id = p.credential_id
        AND c.revision = p.credential_revision AND c.active = 1
      WHERE p.subject_id = a.id AND p.module_id = ${AppAuth.strategies.password.persistence.moduleId}
    ) AS passwords
    FROM accounts a WHERE a.id = ${ownerId}
  `;
  return account;
});

export const ensureOwner = Effect.fnUntraced(function* (
  db: Parameters<typeof databaseLayer>[0],
) {
  const database = databaseLayer(db);
  const readOwner = ownerState.pipe(Effect.provide(database));
  const existing = yield* readOwner;
  if (existing) {
    if (
      existing.active !== 1 ||
      existing.emails !== 1 ||
      existing.passwords !== 1
    )
      return yield* Effect.fail(
        new Error("Existing owner is missing an active email or password."),
      );
    return { ready: true };
  }

  const email = yield* Schema.decodeUnknownEffect(AuthSchema.Email)(
    yield* Config.String("OWNER_EMAIL"),
  );
  const password = yield* Config.Redacted("OWNER_PASSWORD");
  if (!/^[A-Za-z0-9_-]{43}$/.test(Redacted.value(password))) {
    return yield* Effect.fail(
      new Error(
        "Generate OWNER_PASSWORD from 32 random bytes encoded as base64url.",
      ),
    );
  }
  const secret = yield* Config.Redacted("AUTH_SECRET");
  const dependencies = authDependencies(
    database,
    secret,
    BootstrapPasswordPolicy,
    disabledEmail,
  );
  yield* Effect.gen(function* () {
    const auth = yield* AppAuth;
    yield* auth.register({
      email,
      newPassword: Redacted.value(password),
      requestId: Password.PasswordCommandId.make(crypto.randomUUID()),
      registration: {},
    });
  }).pipe(
    Effect.provide(AppAuth.layer.pipe(Layer.provide(dependencies))),
    Effect.provideService(Auth.AuthRequest, {
      invocation: { _tag: "Guest" },
      credentials: {},
      credentialCommandSink: () => Effect.void,
    }),
  );

  const owner = yield* readOwner;
  if (owner?.active !== 1 || owner.emails !== 1 || owner.passwords !== 1)
    return yield* Effect.fail(
      new Error("Owner provisioning did not create an active account."),
    );
  return { ready: true };
});

export const provisionOwner = (resource: Cloudflare.D1.Database) =>
  Alchemy.Action(
    "ProvisionOwner",
    Effect.gen(function* () {
      const database = yield* Cloudflare.D1.QueryDatabase(resource);
      return Effect.fn(function* (_input: { databaseId: string }) {
        const db = yield* database.raw;
        return yield* ensureOwner(db);
      });
    }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal)),
  );
