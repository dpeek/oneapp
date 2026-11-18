import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import {
  type VaultSetup,
  vaultKdfIterations,
} from "../../vault-setup-contract.ts";
import type { personalVaultLogins, personalVaults } from "./tables.ts";

export type PersonalVault = typeof personalVaults.$inferSelect;
export type PersonalLogin = Omit<
  typeof personalVaultLogins.$inferSelect,
  "createDigest"
>;
export type StoredPersonalLogin = Omit<PersonalLogin, "details"> & {
  details: string;
};

export const personalLoginColumns = (table: string) =>
  `${table}.id, ${table}.vault_id AS vaultId, ${table}.name,
   ${table}.wrapped_key AS wrappedKey, ${table}.details, ${table}.created_at AS createdAt,
   ${table}.revision_at AS revisionAt, ${table}.deleted_at AS deletedAt`;

export const decodeStoredLogin = ({
  details,
  ...row
}: StoredPersonalLogin): PersonalLogin => ({
  ...row,
  details: JSON.parse(details),
});

export const readPersonalVault = async (db: WorkerEnv["DB"], ownerId: string) =>
  db
    .prepare(
      `
    SELECT id, owner_id AS ownerId, kdf_salt AS kdfSalt,
           kdf_iterations AS kdfIterations, wrapped_key AS wrappedKey,
           key_id AS keyId, wrapped_private_key AS wrappedPrivateKey,
           public_key AS publicKey, created_at AS createdAt, revision_at AS revisionAt
    FROM personal_vaults WHERE owner_id = ?
  `,
    )
    .bind(ownerId)
    .first<PersonalVault>();

export const readPersonalLogins = async (
  db: WorkerEnv["DB"],
  vaultId: string,
) =>
  (
    await db
      .prepare(
        `
    SELECT ${personalLoginColumns("l")}
    FROM personal_vault_logins l WHERE l.vault_id = ? ORDER BY l.id
  `,
      )
      .bind(vaultId)
      .all<StoredPersonalLogin>()
  ).results.map(decodeStoredLogin);

export const initializePersonalVault = async (
  db: WorkerEnv["DB"],
  session: {
    subjectId: string;
    sessionId: string;
    securityRevision: string;
    claims: { email: string };
  },
  keys: typeof VaultSetup.Type,
) => {
  const now = Date.now();
  const inserted = await db
    .prepare(
      `
    INSERT INTO personal_vaults (
      id, owner_id, kdf_salt, kdf_iterations, wrapped_key, key_id,
      wrapped_private_key, public_key, created_at, revision_at
    )
    SELECT ?, a.id, ?, ?, ?, ?, ?, ?, ?, ?
    FROM accounts a
    JOIN oneapp_auth_sessions s ON s.subject_id = a.id AND s.security_revision = a.security_revision
    JOIN oneapp_auth_identifiers i ON i.subject_id = a.id AND i.namespace = 'email' AND i.active = 1
    WHERE a.id = ? AND a.active = 1 AND a.security_revision = ?
      AND s.session_id = ? AND s.expires_at > ? AND s.absolute_expires_at > ?
      AND i.value = ?
    ON CONFLICT (owner_id) DO NOTHING
    RETURNING id
  `,
    )
    .bind(
      crypto.randomUUID(),
      keys.kdfSalt,
      vaultKdfIterations,
      keys.wrappedKey,
      keys.keyId,
      keys.wrappedPrivateKey,
      keys.publicKey,
      now,
      now,
      session.subjectId,
      session.securityRevision,
      session.sessionId,
      now,
      now,
      session.claims.email,
    )
    .first<{ id: string }>();

  if (inserted) return "created";
  const vault = await readPersonalVault(db, session.subjectId);
  if (!vault) return "session_changed";
  return vault.wrappedKey === keys.wrappedKey &&
    vault.keyId === keys.keyId &&
    vault.wrappedPrivateKey === keys.wrappedPrivateKey &&
    vault.publicKey === keys.publicKey &&
    vault.kdfSalt === keys.kdfSalt &&
    vault.kdfIterations === vaultKdfIterations
    ? "ready"
    : "conflict";
};
