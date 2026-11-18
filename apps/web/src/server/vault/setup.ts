import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import { ByteSize, Effect, Layer, Result } from "effect";
import { Base64 } from "effect/encoding";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  normalizeVaultSalt,
  VaultSetup,
  vaultSetupPath,
  VaultSetupStatus,
} from "../../vault-setup-contract.ts";
import { jsonError, privateHeaders } from "../api-response.ts";
import { AppAuth, type authHttp } from "../auth.ts";
import { initializePersonalVault, readPersonalVault } from "./personal.ts";

const sessionRequired = () => jsonError(401, "Sign in to set up your vault.");
const unavailable = () =>
  jsonError(503, "Vault setup is temporarily unavailable.");

const validVaultPublicKey = async (encoded: string) => {
  const bytes = Base64.decode(encoded);
  if (Result.isFailure(bytes)) return false;
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      new Uint8Array(bytes.success),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    return (key.algorithm as RsaHashedKeyAlgorithm).modulusLength === 2048;
  } catch {
    return false;
  }
};

export const vaultSetupRoutes = (
  http: ReturnType<typeof authHttp>,
  db: WorkerEnv["DB"],
) =>
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      vaultSetupPath,
      Effect.gen(function* () {
        const auth = yield* AppAuth;
        const session = yield* auth.requireSession;
        const vault = yield* Effect.tryPromise(() =>
          readPersonalVault(db, session.subjectId),
        );
        return yield* HttpServerResponse.schemaJson(VaultSetupStatus)(
          vault
            ? { initialized: true }
            : {
                initialized: false,
                kdfSalt: normalizeVaultSalt(session.claims.email),
              },
          { headers: privateHeaders },
        );
      }).pipe(
        Effect.catchTags({
          AuthenticationRequired: sessionRequired,
          UnknownError: unavailable,
        }),
      ),
    ),
    HttpRouter.add(
      "POST",
      vaultSetupPath,
      http
        .protect(
          Effect.gen(function* () {
            const auth = yield* AppAuth;
            const session = yield* auth.requireSession;
            const input = yield* HttpServerRequest.schemaBodyJson(VaultSetup, {
              onExcessProperty: "error",
            }).pipe(
              Effect.provideService(
                HttpServerRequest.MaxBodySize,
                ByteSize.kibibytes(8),
              ),
              Effect.option,
            );
            if (input._tag === "None")
              return yield* jsonError(400, "Vault key material is invalid.");
            if (
              input.value.kdfSalt !== normalizeVaultSalt(session.claims.email)
            )
              return yield* jsonError(
                403,
                "Your account changed. Reload the vault page before continuing.",
              );
            if (
              !(yield* Effect.promise(() =>
                validVaultPublicKey(input.value.publicKey),
              ))
            )
              return yield* jsonError(400, "Vault public key is invalid.");
            const result = yield* Effect.tryPromise(() =>
              initializePersonalVault(db, session, input.value),
            );
            if (result === "session_changed") return yield* sessionRequired();
            if (result === "conflict")
              return yield* jsonError(409, "A password vault already exists.");
            return HttpServerResponse.empty({
              status: result === "created" ? 201 : 204,
              headers: privateHeaders,
            });
          }),
        )
        .pipe(
          Effect.catchTags({
            AuthenticationRequired: sessionRequired,
            HookDenied: () => jsonError(403, "Request not allowed."),
            UnknownError: unavailable,
          }),
        ),
    ),
  );
