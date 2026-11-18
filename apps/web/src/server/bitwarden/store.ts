import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import {
  decodeStoredLogin,
  personalLoginColumns,
  type PersonalLogin,
  type PersonalVault,
  type StoredPersonalLogin,
} from "../vault/personal.ts";
import type { GrantIdentity } from "./tokens.ts";
import {
  accessLifetimeSeconds,
  deviceLifetimeMillis,
  digest,
  issueGrant,
} from "./tokens.ts";

type DB = WorkerEnv["DB"];
export type BrowserIdentity = {
  ownerId: string;
  sessionId: string;
  securityRevision: string;
};
type LiveDevice = GrantIdentity & {
  ownerId: string;
  previousRefreshDigest: string | null;
};

const authorizationLifetime = 120_000;
const codeLifetime = 60_000;
const refreshOverlap = 5_000;

export const startAuthorization = async (
  db: DB,
  browser: BrowserIdentity,
  vaultId: string,
  state: string,
  challenge: string,
  consentDigest: string,
) => {
  const now = Date.now();
  await db.batch([
    db
      .prepare("DELETE FROM bitwarden_authorizations WHERE expires_at <= ?")
      .bind(now),
    db
      .prepare(
        `
      INSERT INTO bitwarden_authorizations
        (id, vault_id, browser_session_id, security_revision, consent_digest, state, challenge, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .bind(
        crypto.randomUUID(),
        vaultId,
        browser.sessionId,
        browser.securityRevision,
        consentDigest,
        state,
        challenge,
        now + authorizationLifetime,
      ),
  ]);
};

export const approveAuthorization = async (
  db: DB,
  browser: BrowserIdentity,
  consentDigest: string,
  codeDigest: string,
) => {
  const now = Date.now();
  return db
    .prepare(
      `
    UPDATE bitwarden_authorizations
    SET consent_digest = NULL, code_digest = ?, expires_at = ?
    WHERE consent_digest = ? AND browser_session_id = ? AND security_revision = ? AND expires_at > ?
      AND vault_id IN (SELECT id FROM personal_vaults WHERE owner_id = ?)
    RETURNING state
  `,
    )
    .bind(
      codeDigest,
      now + codeLifetime,
      consentDigest,
      browser.sessionId,
      browser.securityRevision,
      now,
      browser.ownerId,
    )
    .first<{ state: string }>();
};

const liveAuthorization = `
  FROM bitwarden_authorizations g
  JOIN personal_vaults v ON v.id = g.vault_id
  JOIN accounts a ON a.id = v.owner_id AND a.active = 1 AND a.security_revision = g.security_revision
  JOIN oneapp_auth_sessions s
    ON s.session_id = g.browser_session_id AND s.subject_id = a.id
    AND s.security_revision = g.security_revision AND s.expires_at > ? AND s.absolute_expires_at > ?
  JOIN oneapp_auth_identifiers i ON i.subject_id = a.id AND i.namespace = 'email' AND i.active = 1
  WHERE g.code_digest = ? AND g.challenge = ? AND g.expires_at > ?
`;

export const redeemAuthorization = async (
  db: DB,
  origin: string,
  secret: string,
  codeDigest: string,
  challenge: string,
  deviceId: string,
) => {
  const now = Date.now();
  const conditions = [now, now, codeDigest, challenge, now] as const;
  const record = await db
    .prepare(
      `
    SELECT g.id, g.vault_id AS vaultId, v.owner_id AS ownerId, i.value AS email,
           (i.verified_at IS NOT NULL) AS emailVerified
    ${liveAuthorization}
  `,
    )
    .bind(...conditions)
    .first<{
      id: string;
      vaultId: string;
      ownerId: string;
      email: string;
      emailVerified: number;
    }>();
  if (!record) return null;
  const { ownerId, ...grantOwner } = record;
  const identity = {
    ...grantOwner,
    deviceId,
    generation: 0,
    issuedAt: Math.floor(now / 1000),
  };
  const grant = await issueGrant(origin, secret, identity);
  const [accessDigest, refreshDigest] = await Promise.all([
    digest(grant.access_token),
    digest(grant.refresh_token),
  ]);
  const atCommit = Date.now();
  const [, inserted] = await db.batch<{ id: string }>([
    db
      .prepare("DELETE FROM bitwarden_device_sessions WHERE expires_at <= ?")
      .bind(atCommit),
    // The row and code consumption commit together. Only the winning request creates a device.
    db
      .prepare(
        `
      INSERT INTO bitwarden_device_sessions
        (id, vault_id, device_id, security_revision, email, email_verified, expires_at,
         generation, issued_at, access_digest, refresh_digest)
      SELECT g.id, g.vault_id, ?, g.security_revision, i.value, (i.verified_at IS NOT NULL),
             ?, 0, ?, ?, ?
      ${liveAuthorization} AND i.value = ? AND (i.verified_at IS NOT NULL) = ?
      ON CONFLICT(id) DO NOTHING
      RETURNING id
    `,
      )
      .bind(
        deviceId,
        now + deviceLifetimeMillis,
        identity.issuedAt,
        accessDigest,
        refreshDigest,
        atCommit,
        atCommit,
        codeDigest,
        challenge,
        atCommit,
        record.email,
        record.emailVerified,
      ),
    db
      .prepare(
        `
      DELETE FROM bitwarden_authorizations
      WHERE id = ? AND EXISTS (SELECT 1 FROM bitwarden_device_sessions WHERE id = ?)
    `,
      )
      .bind(record.id, record.id),
  ]);
  return inserted?.results.length === 1 ? { grant, identity, ownerId } : null;
};

const deviceSource = `
  FROM bitwarden_device_sessions d
  JOIN personal_vaults v ON v.id = d.vault_id
  JOIN accounts a ON a.id = v.owner_id AND a.active = 1 AND a.security_revision = d.security_revision
`;

const liveDevices = `
  SELECT d.id, d.vault_id AS vaultId, d.device_id AS deviceId, v.owner_id AS ownerId,
         d.email, d.email_verified AS emailVerified, d.generation, d.issued_at AS issuedAt,
         d.previous_refresh_digest AS previousRefreshDigest
  ${deviceSource}
  WHERE d.expires_at > ?
`;

const activeAccess = `(
  (d.access_digest = ? AND (d.issued_at + ?) * 1000 > ?) OR
  (d.previous_access_digest = ? AND d.retry_until > ?)
)`;
const accessParameters = (accessDigest: string, now: number) =>
  [accessDigest, accessLifetimeSeconds, now, accessDigest, now] as const;

const authorizedVault = `
  SELECT v.id, v.revision_at
  ${deviceSource}
  WHERE v.id = ? AND v.owner_id = ? AND v.key_id = ?
    AND d.expires_at > ? AND ${activeAccess}
`;
const vaultAccessParameters = (
  vault: PersonalVault,
  accessDigest: string,
  now: number,
) =>
  [
    vault.id,
    vault.ownerId,
    vault.keyId,
    now,
    ...accessParameters(accessDigest, now),
  ] as const;

export const readDeviceByAccess = async (db: DB, accessDigest: string) => {
  const now = Date.now();
  return db
    .prepare(`${liveDevices} AND ${activeAccess}`)
    .bind(now, ...accessParameters(accessDigest, now))
    .first<LiveDevice>();
};

type EncryptedLogin = Pick<PersonalLogin, "name" | "wrappedKey" | "details">;

export const savePersonalLogin = async (
  db: DB,
  accessDigest: string,
  vault: PersonalVault,
  { name, wrappedKey, details }: EncryptedLogin,
) => {
  const serializedDetails = JSON.stringify(details);
  const createDigest = await digest(
    JSON.stringify([name, wrappedKey, serializedDetails]),
  );
  const now = Date.now();
  const id = crypto.randomUUID();
  const scope = vaultAccessParameters(vault, accessDigest, now);

  // The grant is checked again in the same transaction as the insert. A retry
  // returns the existing row and advances neither the item nor the vault revision.
  const [, , saved] = await db.batch<StoredPersonalLogin>([
    db
      .prepare(
        `
      INSERT INTO personal_vault_logins
        (id, vault_id, name, wrapped_key, details, create_digest, created_at, revision_at)
      SELECT ?, v.id, ?, ?, ?, ?, ?, max(v.revision_at + 1, ?)
      FROM (${authorizedVault}) v WHERE true
      ON CONFLICT (vault_id, create_digest) DO NOTHING
    `,
      )
      .bind(
        id,
        name,
        wrappedKey,
        serializedDetails,
        createDigest,
        now,
        now,
        ...scope,
      ),
    db
      .prepare(
        `
      UPDATE personal_vaults
      SET revision_at = (SELECT revision_at FROM personal_vault_logins WHERE id = ?)
      WHERE id = ? AND EXISTS (SELECT 1 FROM personal_vault_logins WHERE id = ? AND vault_id = ?)
    `,
      )
      .bind(id, vault.id, id, vault.id),
    db
      .prepare(
        `
      SELECT ${personalLoginColumns("l")} FROM personal_vault_logins l
      JOIN (${authorizedVault}) v ON l.vault_id = v.id
      WHERE l.create_digest = ?
    `,
      )
      .bind(...scope, createDigest),
  ]);
  const row = saved?.results[0];
  return row ? decodeStoredLogin(row) : null;
};

type LoginChange =
  | { kind: "edit"; expectedRevision: number; item: EncryptedLogin }
  | { kind: "delete" | "restore" };

export const changePersonalLogin = async (
  db: DB,
  accessDigest: string,
  vault: PersonalVault,
  id: string,
  change: LoginChange,
) => {
  const now = Date.now();
  const scope = vaultAccessParameters(vault, accessDigest, now);
  const filter =
    change.kind === "edit"
      ? "l.deleted_at IS NULL AND l.revision_at = ?"
      : change.kind === "delete"
        ? "l.deleted_at IS NULL"
        : "l.deleted_at IS NOT NULL";
  const filterParams = change.kind === "edit" ? [change.expectedRevision] : [];
  const assignment =
    change.kind === "edit"
      ? "name = ?, wrapped_key = ?, details = ?"
      : change.kind === "delete"
        ? "deleted_at = v.revision_at"
        : "deleted_at = NULL";
  const values =
    change.kind === "edit"
      ? [
          change.item.name,
          change.item.wrappedKey,
          JSON.stringify(change.item.details),
        ]
      : [];
  // Both writes use the same access and item checks in one D1 transaction.
  // The item takes the new vault revision so sync observes a single change.
  const [, updated, current] = await db.batch<
    StoredPersonalLogin | { id: null }
  >([
    db
      .prepare(
        `
      UPDATE personal_vaults
      SET revision_at = max(personal_vaults.revision_at + 1, l.revision_at + 1, ?)
      FROM personal_vault_logins l JOIN (${authorizedVault}) v ON l.vault_id = v.id
      WHERE personal_vaults.id = v.id AND l.id = ? AND ${filter}
    `,
      )
      .bind(now, ...scope, id, ...filterParams),
    db
      .prepare(
        `
      UPDATE personal_vault_logins AS l
      SET ${assignment}, revision_at = v.revision_at
      FROM (${authorizedVault}) v
      WHERE l.vault_id = v.id AND l.id = ? AND ${filter}
      RETURNING ${personalLoginColumns("personal_vault_logins")}
    `,
      )
      .bind(...values, ...scope, id, ...filterParams),
    db
      .prepare(
        `
      SELECT ${personalLoginColumns("l")} FROM (${authorizedVault}) v
      LEFT JOIN personal_vault_logins l ON l.vault_id = v.id AND l.id = ?
    `,
      )
      .bind(...scope, id),
  ]);
  const row = updated?.results[0];
  if (row?.id != null)
    return { status: "updated", item: decodeStoredLogin(row) } as const;
  const visible = current?.results[0];
  if (!visible) return { status: "invalid_token" } as const;
  if (visible.id === null) return { status: "not_found" } as const;
  // The stock client sends no revision for lifecycle actions. Repeating the
  // current state succeeds without changing deletion time or revisions.
  if (change.kind !== "edit")
    return { status: "updated", item: decodeStoredLogin(visible) } as const;
  return {
    status: visible.deletedAt === null ? "conflict" : "trashed",
  } as const;
};

const readDeviceByRefresh = (db: DB, refreshDigest: string, now: number) =>
  db
    .prepare(
      `${liveDevices} AND (d.refresh_digest = ? OR
    (d.previous_refresh_digest = ? AND d.retry_until > ?))
  `,
    )
    .bind(now, refreshDigest, refreshDigest, now)
    .first<LiveDevice>();

export const refreshDevice = async (
  db: DB,
  origin: string,
  secret: string,
  refreshDigest: string,
) => {
  const device = await readDeviceByRefresh(db, refreshDigest, Date.now());
  if (!device) return null;
  // Concurrent stock clients can present the same refresh token. Reconstruct the
  // winning grant from its persisted generation and timestamp within the overlap.
  if (device.previousRefreshDigest === refreshDigest)
    return issueGrant(origin, secret, device);
  const next = {
    ...device,
    generation: device.generation + 1,
    issuedAt: Math.floor(Date.now() / 1000),
  };
  const grant = await issueGrant(origin, secret, next);
  const [nextAccess, nextRefresh] = await Promise.all([
    digest(grant.access_token),
    digest(grant.refresh_token),
  ]);
  const now = Date.now();
  const updated = await db
    .prepare(
      `
    UPDATE bitwarden_device_sessions
    SET previous_access_digest = CASE WHEN (issued_at + ?) * 1000 > ? THEN access_digest ELSE NULL END,
        previous_refresh_digest = refresh_digest, retry_until = ?,
        access_digest = ?, refresh_digest = ?, generation = ?, issued_at = ?
    WHERE id = ? AND refresh_digest = ? AND expires_at > ?
      AND EXISTS (
        SELECT 1 FROM personal_vaults v
        JOIN accounts a ON a.id = v.owner_id AND a.active = 1
        WHERE v.id = bitwarden_device_sessions.vault_id
          AND a.security_revision = bitwarden_device_sessions.security_revision
      )
    RETURNING id
  `,
    )
    .bind(
      accessLifetimeSeconds,
      now + refreshOverlap,
      now + refreshOverlap,
      nextAccess,
      nextRefresh,
      next.generation,
      next.issuedAt,
      next.id,
      refreshDigest,
      now,
    )
    .first<{ id: string }>();
  if (updated) return grant;
  const winner = await readDeviceByRefresh(db, refreshDigest, Date.now());
  return winner?.previousRefreshDigest === refreshDigest
    ? issueGrant(origin, secret, winner)
    : null;
};
