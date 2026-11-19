import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import {
  changePersonalItem as changeVaultItem,
  editPersonalItem as editVaultItem,
  createPersonalItem,
  type EncryptedItem,
  type PersonalVault,
} from "../vault/personal.ts";
import { digest } from "../digest.ts";
import type { BitwardenClient, GrantIdentity } from "./tokens.ts";
import {
  accessLifetimeSeconds,
  deviceLifetimeMillis,
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
  clientId: BitwardenClient,
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
        (id, vault_id, browser_session_id, security_revision, consent_digest, state, challenge, expires_at, client_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        clientId,
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
    RETURNING state, client_id AS clientId
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
    .first<{ state: string; clientId: BitwardenClient }>();
};

const liveAuthorization = `
  FROM bitwarden_authorizations g
  JOIN personal_vaults v ON v.id = g.vault_id
  JOIN accounts a ON a.id = v.owner_id AND a.active = 1 AND a.security_revision = g.security_revision
  JOIN oneapp_auth_sessions s
    ON s.session_id = g.browser_session_id AND s.subject_id = a.id
    AND s.security_revision = g.security_revision AND s.expires_at > ? AND s.absolute_expires_at > ?
  JOIN oneapp_auth_identifiers i ON i.subject_id = a.id AND i.namespace = 'email' AND i.active = 1
  WHERE g.code_digest = ? AND g.challenge = ? AND g.expires_at > ? AND g.client_id = ?
`;

export const redeemAuthorization = async (
  db: DB,
  origin: string,
  secret: string,
  clientId: BitwardenClient,
  codeDigest: string,
  challenge: string,
  device: { id: string; name: string | null },
) => {
  const now = Date.now();
  const conditions = [now, now, codeDigest, challenge, now, clientId] as const;
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
    clientId,
    deviceId: device.id,
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
        (id, vault_id, device_id, device_name, security_revision, email, email_verified, expires_at,
         generation, issued_at, access_digest, refresh_digest, client_id)
      SELECT g.id, g.vault_id, ?, ?, g.security_revision, i.value, (i.verified_at IS NOT NULL),
             ?, 0, ?, ?, ?, g.client_id
      ${liveAuthorization} AND i.value = ? AND (i.verified_at IS NOT NULL) = ?
      ON CONFLICT(id) DO NOTHING
      RETURNING id
    `,
      )
      .bind(
        device.id,
        device.name,
        now + deviceLifetimeMillis,
        identity.issuedAt,
        accessDigest,
        refreshDigest,
        atCommit,
        atCommit,
        codeDigest,
        challenge,
        atCommit,
        clientId,
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
         d.email, d.email_verified AS emailVerified, d.generation, d.issued_at AS issuedAt, d.client_id AS clientId,
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
export const deviceAuthorization = (
  vault: PersonalVault,
  accessDigest: string,
) => ({
  query: authorizedVault,
  parameters: (now: number) => [
    vault.id,
    vault.ownerId,
    vault.keyId,
    now,
    ...accessParameters(accessDigest, now),
  ],
});

export const attachmentDownloadAuthorization = (device: string) => ({
  query: `SELECT v.id, v.revision_at ${deviceSource} WHERE d.expires_at > ? AND d.id = ?`,
  parameters: (now: number) => [now, device],
});
export const readDeviceByAccess = async (db: DB, accessDigest: string) => {
  const now = Date.now();
  return db
    .prepare(`${liveDevices} AND ${activeAccess}`)
    .bind(now, ...accessParameters(accessDigest, now))
    .first<LiveDevice>();
};

export const savePersonalItem = (
  db: DB,
  accessDigest: string,
  vault: PersonalVault,
  item: EncryptedItem & { folderId?: string | null },
) =>
  createPersonalItem(
    db,
    vault.id,
    deviceAuthorization(vault, accessDigest),
    item,
  );

export const changePersonalItem = (
  db: DB,
  accessDigest: string,
  vault: PersonalVault,
  id: string,
  change: Parameters<typeof changeVaultItem>[3],
) => changeVaultItem(db, deviceAuthorization(vault, accessDigest), id, change);

export const editPersonalItem = (
  db: DB,
  accessDigest: string,
  vault: PersonalVault,
  id: string,
  edit: Parameters<typeof editVaultItem>[3],
) => editVaultItem(db, deviceAuthorization(vault, accessDigest), id, edit);

const readDeviceByRefresh = (
  db: DB,
  clientId: BitwardenClient,
  refreshDigest: string,
  now: number,
) =>
  db
    .prepare(
      `${liveDevices} AND d.client_id = ? AND (d.refresh_digest = ? OR
    (d.previous_refresh_digest = ? AND d.retry_until > ?))
  `,
    )
    .bind(now, clientId, refreshDigest, refreshDigest, now)
    .first<LiveDevice>();

export const refreshDevice = async (
  db: DB,
  origin: string,
  secret: string,
  clientId: BitwardenClient,
  refreshDigest: string,
) => {
  const device = await readDeviceByRefresh(
    db,
    clientId,
    refreshDigest,
    Date.now(),
  );
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
  const winner = await readDeviceByRefresh(
    db,
    clientId,
    refreshDigest,
    Date.now(),
  );
  return winner?.previousRefreshDigest === refreshDigest
    ? issueGrant(origin, secret, winner)
    : null;
};
