import {
  Auth,
  Email,
  Http,
  Password,
  Schema as AuthSchema,
  Sessions,
} from "@yielded/auth";
import * as PasswordScrypt from "@yielded/auth/PasswordScrypt";
import * as WebCrypto from "@yielded/auth/WebCrypto";
import { DateTime, Effect, Layer, Schema } from "effect";
import { Kdf } from "effect/crypto";
import { AuthApi } from "../auth-contract.ts";

export const AppAuth = Auth.make(AuthApi, {
  sessions: Sessions.stateful(),
  strategies: {
    password: Password.make({
      registration: Schema.Struct({}),
      policy: {
        ...Password.defaultPasswordMethodPolicy,
        requireImmediateInvalidation: true,
      },
      reset: Password.resetLink({
        url: "https://oneapp.invalid/reset-password",
      }),
    }),
    email: Email.makeAddresses({
      addresses: {
        maximumEvidenceAgeMillis: 300_000,
        requireImmediateInvalidation: true,
      },
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

export const passwordRecoveryRequirement: Sessions.AuthenticationRequirement = {
  alternatives: [
    { ...passwordRequirement.alternatives[0], factors: ["possession"] },
  ],
  maximumAgeMillis: 60_000,
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

export const AccountActionEvidence = Layer.mergeAll(
  Layer.succeed(Password.PasswordActionEvidence, {
    verify: Effect.fnUntraced(function* ({
      challenge,
      invocation,
      currentPasswordEvidence,
      recovery,
    }) {
      if (
        challenge.action === "reset-password" &&
        recovery?.purpose === "password-reset" &&
        recovery.binding._tag === "Subject" &&
        recovery.binding.revision.subjectId === challenge.revision.subjectId &&
        challenge.targetCredentialId !== undefined &&
        recovery.candidate !== undefined
      ) {
        // The native reset transaction must redeem this exact proof before
        // it can replace the password or invalidate sessions.
        const verifiedAt = yield* DateTime.now;
        return {
          evidence: Sessions.AuthenticationEvidence.make({
            flowId: Sessions.AuthenticationFlowId.make(challenge.commandId),
            bindingDigest: challenge.bindingDigest,
            revision: recovery.binding.revision,
            proofs: [
              {
                method: "password-reset",
                credentialId: challenge.targetCredentialId,
                factors: ["possession"],
                userVerified: false,
                phishingResistant: false,
                verifiedAt,
              },
            ],
          }),
          requirement: passwordRecoveryRequirement,
        };
      }
      if (
        challenge.action !== "change-password" ||
        invocation._tag !== "Authenticated" ||
        !currentPasswordEvidence
      ) {
        return yield* Password.PasswordActionRequired.make({});
      }
      return {
        evidence: {
          ...currentPasswordEvidence,
          bindingDigest: challenge.bindingDigest,
        },
        requirement: passwordRequirement,
      };
    }),
  }),
  Layer.succeed(Email.EmailActionEvidence, {
    verify: ({ invocation, challenge }) => {
      if (
        invocation._tag !== "Authenticated" ||
        challenge.action !== "verify-address" ||
        challenge.targetIdentifierRevision === undefined ||
        challenge.revision.subjectId !== invocation.subjectId ||
        challenge.revision.credentials.length !== 1
      ) {
        return Effect.fail(Email.EmailActionRequired.make({}));
      }
      const proof = invocation.assurance.evidence?.find(
        (item) =>
          item.method === "password" && item.factors.includes("knowledge"),
      );
      if (!proof) return Effect.fail(Email.EmailActionRequired.make({}));

      // Orumai only issues sessions from its single password credential.
      const [credential] = challenge.revision.credentials;
      return Effect.succeed({
        evidence: Sessions.AuthenticationEvidence.make({
          flowId: Sessions.AuthenticationFlowId.make(challenge.commandId),
          bindingDigest: challenge.bindingDigest,
          revision: challenge.revision,
          proofs: [{ ...proof, credentialId: credential!.credentialId }],
        }),
        requirement: passwordRequirement,
      });
    },
  }),
);
