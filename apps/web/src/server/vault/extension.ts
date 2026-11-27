import {
  type ExtensionVaultLogin,
  extensionVaultPath,
  ExtensionVaultSnapshot,
} from "@orumai/core/vault";
import { Clock, Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import type { ItemContent } from "../../vault-item-content.ts";
import { jsonError, privateHeaders } from "../api-response.ts";
import {
  invalidExtensionResponse,
  requireExtensionToken,
} from "../extension-access.ts";

type KeyParameters = Omit<ExtensionVaultSnapshot, "logins">;
type LoginRow = Pick<
  ExtensionVaultLogin,
  "id" | "name" | "wrappedKey" | "revision"
> & {
  details: string;
};
type VaultRow = KeyParameters & { logins: string };

const projectLogin = ({ details, ...login }: LoginRow): ExtensionVaultLogin => {
  const { credentials, reprompt } = JSON.parse(
    details,
  ) as ItemContent["details"];
  return {
    ...login,
    username: credentials?.username ?? null,
    password: credentials?.password ?? null,
    uris: (credentials?.uris ?? []).map(({ uri, match }) =>
      match === undefined ? { uri } : { uri, match },
    ),
    requiresMasterPassword: reprompt === 1,
  };
};

export const extensionVaultRoutes = HttpRouter.add(
  "GET",
  extensionVaultPath,
  Effect.gen(function* () {
    const token = yield* requireExtensionToken("vault-read");
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    // Recheck the grant in the same read that selects the vault and its logins.
    const [vault] = yield* sql<VaultRow | { keyId: null }>`
      SELECT v.key_id AS "keyId", v.wrapped_key AS "wrappedKey",
             v.kdf_salt AS "kdfSalt", v.kdf_iterations AS "kdfIterations",
        (SELECT json_group_array(json_object(
           'id', l.id, 'name', l.name, 'wrappedKey', l.wrapped_key,
           'revision', l.revision_at, 'details', l.details
         ))
         FROM personal_vault_logins l
         WHERE l.vault_id = v.id AND l.type = 1
           AND l.deleted_at IS NULL AND l.archived_at IS NULL) AS logins
      FROM extension_tokens t
      JOIN accounts a ON a.id = t.owner_id
      LEFT JOIN personal_vaults v ON v.owner_id = a.id
      WHERE t.id = ${token.id} AND t.scope = 'vault-read' AND a.active = 1
        AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ${now})
    `;
    if (!vault) return yield* invalidExtensionResponse();
    if (vault.keyId === null)
      return yield* jsonError(404, "Set up your vault in Orumai.");
    const { logins, ...parameters } = vault;
    return yield* HttpServerResponse.schemaJson(ExtensionVaultSnapshot)(
      {
        ...parameters,
        logins: (JSON.parse(logins) as LoginRow[]).map(projectLogin),
      },
      { headers: privateHeaders },
    );
  }).pipe(Effect.catchTag("InvalidExtensionToken", invalidExtensionResponse)),
);
