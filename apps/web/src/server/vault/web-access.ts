import { ByteSize, Effect, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import { vaultItemBodyLimit } from "../../vault-items-contract.ts";
import { jsonError } from "../api-response.ts";
import { AppAuth } from "../auth.ts";
import type { PersonalVault } from "./personal.ts";

const authorizedBrowserVault = `
  SELECT v.id, v.revision_at
  FROM personal_vaults v
  JOIN accounts a ON a.id = v.owner_id AND a.active = 1
  JOIN oneapp_auth_sessions s ON s.subject_id = a.id AND s.security_revision = a.security_revision
  WHERE v.id = ? AND v.key_id = ? AND a.id = ? AND a.security_revision = ?
    AND s.session_id = ? AND s.expires_at > ? AND s.absolute_expires_at > ?
`;

export const requireSession = Effect.flatMap(
  AppAuth,
  (auth) => auth.requireSession,
);
export const browserAuthorization = (
  vault: PersonalVault,
  session: Effect.Success<typeof requireSession>,
) => ({
  query: authorizedBrowserVault,
  parameters: (now: number) => [
    vault.id,
    vault.keyId,
    session.subjectId,
    session.securityRevision,
    session.sessionId,
    now,
    now,
  ],
});

export const readItemBody = <A>(
  schema: Schema.ConstraintDecoder<A>,
  limit = vaultItemBodyLimit,
) =>
  HttpServerRequest.schemaBodyJson(schema, { onExcessProperty: "error" }).pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(limit)),
    Effect.option,
  );
export const itemWriteErrors = {
  AuthenticationRequired: () => jsonError(401, "Sign in to save a vault item."),
  HookDenied: () => jsonError(403, "Request not allowed."),
  UnknownError: () => jsonError(503, "Could not save your vault item."),
};
export const noVault = () =>
  jsonError(404, "Set up your password vault first.");
export const staleVault = () =>
  jsonError(409, "Unlock your vault again to save this item.");
