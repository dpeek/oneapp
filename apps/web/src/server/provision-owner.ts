import * as Cloudflare from "@alchemy.run/cloudflare";
import { Auth, Password } from "@yielded/auth";
import * as Alchemy from "alchemy";
import { Config, Effect, Layer, Redacted } from "effect";
import { AppAuth, ownerId } from "./auth.ts";
import { authDependencies } from "./database.ts";

export const provisionOwner = (resource: Cloudflare.D1.Database) =>
  Alchemy.Action(
    "ProvisionOwner",
    Effect.gen(function* () {
      const database = yield* Cloudflare.D1.QueryDatabase(resource);
      return Effect.fn(function* ({
        email,
      }: {
        databaseId: string;
        email: string;
      }) {
        const findOwner = database
          .prepare(
            `
      SELECT i.value AS email FROM accounts a
      JOIN oneapp_auth_identifiers i ON i.subject_id = a.id
      WHERE a.id = ? AND a.active = 1 AND i.namespace = 'email' AND i.active = 1
    `,
          )
          .bind(ownerId)
          .first<{ email: string }>();
        const existing = yield* findOwner;
        if (existing) {
          if (existing.email !== email)
            return yield* Effect.fail(
              new Error(
                "The configured owner email differs from the existing owner.",
              ),
            );
          return { ready: true };
        }

        const password = yield* Config.Redacted("OWNER_PASSWORD");
        if (!/^[A-Za-z0-9_-]{43}$/.test(Redacted.value(password))) {
          return yield* Effect.fail(
            new Error(
              "Generate OWNER_PASSWORD from 32 random bytes encoded as base64url.",
            ),
          );
        }
        const secret = yield* Config.Redacted("AUTH_SECRET");
        const db = yield* database.raw;
        const dependencies = authDependencies(db, secret);

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

        const owner = yield* findOwner;
        if (owner?.email !== email)
          return yield* Effect.fail(
            new Error("Owner provisioning did not create an active account."),
          );
        return { ready: true };
      });
    }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal)),
  );
