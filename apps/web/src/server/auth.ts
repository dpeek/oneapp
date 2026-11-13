import {
  Auth,
  EmailDelivery,
  Http,
  Password,
  Schema as AuthSchema,
  Sessions,
} from "@yielded/auth";
import * as PasswordScrypt from "@yielded/auth/PasswordScrypt";
import * as WebCrypto from "@yielded/auth/WebCrypto";
import { Effect, Layer, Redacted, Schema } from "effect";
import { Kdf } from "effect/crypto";
import { AuthApi } from "../auth-contract.ts";

export const AppAuth = Auth.make(AuthApi, {
  sessions: Sessions.stateful(),
  strategies: {
    password: Password.make({
      registration: Schema.Struct({}),
      reset: Password.resetLink({
        url: "https://oneapp.invalid/reset-password",
      }),
    }),
  },
  defaultStrategy: "password",
});

export const sessionCookieName = "__Host-effect-auth-session";
export const authHttp = (origin: string) =>
  Http.make(AppAuth, { origin, cookie: { name: sessionCookieName } });

export const ownerId = AuthSchema.SubjectId.make("owner");

export const passwordRequirement: Sessions.AuthenticationRequirement = {
  alternatives: [
    {
      factors: ["knowledge"],
      userVerified: false,
      phishingResistant: false,
      minimumCredentials: 1,
    },
  ],
  maximumAgeMillis: 30 * 24 * 60 * 60 * 1000,
};

export const CryptoLive = Layer.mergeAll(
  WebCrypto.layer,
  Kdf.layerWebCrypto,
  PasswordScrypt.layer,
);

export const PasswordLive = Password.PasswordHashing.layer(
  Password.defaultScryptPasswordHashingConfig,
).pipe(Layer.provide(Password.KdfAdmission.layer()), Layer.provide(CryptoLive));

export const ClaimsLive = Layer.succeed(
  AppAuth.strategies.password.SessionClaims,
  {
    resolve: ({ credential }) =>
      Effect.succeed({ email: credential.identifier.value }),
  },
);

export const OwnerPasswordPolicy = Layer.succeed(
  Password.CompromisedPasswords,
  {
    check: (password) =>
      Effect.succeed(
        /^[A-Za-z0-9_-]{43}$/.test(Redacted.value(password))
          ? { _tag: "Allowed" }
          : { _tag: "Rejected", reason: "common" },
      ),
  },
);

// Password management is present for deploy-time registration. The HTTP
// contract exposes sign-in only, and these capabilities fail closed.
export const DisabledPasswordManagement = Layer.mergeAll(
  Layer.succeed(Password.PasswordActionEvidence, {
    verify: () => Effect.fail(Password.PasswordActionRequired.make({})),
  }),
  Layer.succeed(EmailDelivery.EmailDelivery, {
    send: () => Effect.die("Email delivery is disabled"),
  }),
);
