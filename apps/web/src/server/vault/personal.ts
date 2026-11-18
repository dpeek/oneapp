import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import {
  type EditVaultLogin,
  hostUriMatch,
} from "../../vault-items-contract.ts";
import {
  type VaultSetup,
  vaultKdfIterations,
} from "../../vault-setup-contract.ts";
import { digest } from "../digest.ts";
import { itemContent, type ItemContent } from "../../vault-item-content.ts";
import type { personalVaultItems, personalVaults } from "./tables.ts";

export type PersonalVault = typeof personalVaults.$inferSelect;
export type PersonalItem = Omit<
  typeof personalVaultItems.$inferSelect,
  "createDigest" | "details" | "type"
> &
  ItemContent;
type StoredPersonalItem = Omit<PersonalItem, "details"> & {
  details: string;
};

const personalItemColumns = (table: string) =>
  `${table}.id, ${table}.vault_id AS vaultId, ${table}.name,
   ${table}.wrapped_key AS wrappedKey, ${table}.type, ${table}.details, ${table}.created_at AS createdAt,
   ${table}.revision_at AS revisionAt, ${table}.deleted_at AS deletedAt`;

const decodeStoredItem = ({
  details,
  ...row
}: StoredPersonalItem): PersonalItem => ({
  ...row,
  ...itemContent(row.type, JSON.parse(details)),
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

export const readPersonalItem = async (
  db: WorkerEnv["DB"],
  vaultId: string,
  id: string,
) => {
  const row = await db
    .prepare(
      `SELECT ${personalItemColumns("l")} FROM personal_vault_logins l WHERE l.vault_id = ? AND l.id = ?`,
    )
    .bind(vaultId, id)
    .first<StoredPersonalItem>();
  return row ? decodeStoredItem(row) : null;
};

export const readPersonalItems = async (
  db: WorkerEnv["DB"],
  vaultId: string,
): Promise<PersonalItem[]> =>
  (
    await db
      .prepare(
        `
    SELECT ${personalItemColumns("l")}
    FROM personal_vault_logins l
    WHERE l.vault_id = ? ORDER BY l.id
  `,
      )
      .bind(vaultId)
      .all<StoredPersonalItem>()
  ).results.map(decodeStoredItem);

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

export type EncryptedItem = Pick<PersonalItem, "name" | "wrappedKey"> &
  ItemContent;

export type VaultAuthorization = {
  query: string;
  parameters: (now: number) => readonly (string | number)[];
};

export const createPersonalItem = async (
  db: WorkerEnv["DB"],
  vaultId: string,
  authorization: VaultAuthorization,
  { name, wrappedKey, details, type }: EncryptedItem,
) => {
  const serializedDetails = JSON.stringify(details);
  const createDigest = await digest(
    JSON.stringify(
      type <= 2
        ? [name, wrappedKey, serializedDetails]
        : [type, name, wrappedKey, serializedDetails],
    ),
  );
  const now = Date.now();
  const id = crypto.randomUUID();
  const scope = authorization.parameters(now);

  // Authorization is checked again in the same transaction as the insert. A retry
  // returns the existing row and advances neither the item nor the vault revision.
  const [, , saved] = await db.batch<StoredPersonalItem>([
    db
      .prepare(
        `
      INSERT INTO personal_vault_logins
        (id, vault_id, name, wrapped_key, details, create_digest, created_at, revision_at, type)
      SELECT ?, v.id, ?, ?, ?, ?, ?, max(v.revision_at + 1, ?), ?
      FROM (${authorization.query}) v WHERE true
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
        type,
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
      .bind(id, vaultId, id, vaultId),
    db
      .prepare(
        `
      SELECT ${personalItemColumns("l")} FROM personal_vault_logins l
      JOIN (${authorization.query}) v ON l.vault_id = v.id
      WHERE l.create_digest = ? AND l.type = ?
    `,
      )
      .bind(...scope, createDigest, type),
  ]);
  const row = saved?.results[0];
  return row ? decodeStoredItem(row) : null;
};

type ItemChange =
  | {
      kind: "edit";
      expectedRevision: number;
      item: EncryptedItem;
      alreadyApplied?: (item: PersonalItem) => boolean;
    }
  | {
      kind: "edit_note";
      expectedRevision: number;
      name: string;
      notes: string | null;
    }
  | { kind: "delete" | "restore"; expectedRevision?: number };

const currentItem = (db: WorkerEnv["DB"], query: string) =>
  db.prepare(
    `
    SELECT ${personalItemColumns("l")} FROM (${query}) v
    LEFT JOIN personal_vault_logins l ON l.vault_id = v.id AND l.id = ?
  `,
  );

export const changePersonalItem = async (
  db: WorkerEnv["DB"],
  authorization: VaultAuthorization,
  id: string,
  change: ItemChange,
) => {
  const now = Date.now();
  const scope = authorization.parameters(now);
  const editing = change.kind === "edit" || change.kind === "edit_note";
  const type = change.kind === "edit" ? change.item.type : 2;
  const expectedRevision = change.expectedRevision;
  const lifecycleState = change.kind === "delete" ? "IS NULL" : "IS NOT NULL";
  const filter = editing
    ? "l.deleted_at IS NULL AND l.revision_at = ? AND l.type = ?"
    : `l.deleted_at ${lifecycleState}${expectedRevision === undefined ? "" : " AND l.revision_at = ?"}`;
  const filterParams = editing
    ? [change.expectedRevision, type]
    : expectedRevision === undefined
      ? []
      : [expectedRevision];
  const assignment =
    change.kind === "edit"
      ? "name = ?, wrapped_key = ?, details = ?"
      : change.kind === "edit_note"
        ? "name = ?, details = json_set(l.details, '$.notes', ?)"
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
      : change.kind === "edit_note"
        ? [change.name, change.notes]
        : [];
  // Both writes use the same access and item checks in one D1 transaction.
  // The item takes the new vault revision so sync observes a single change.
  const [, updated, current] = await db.batch<
    StoredPersonalItem | { id: null }
  >([
    db
      .prepare(
        `
      UPDATE personal_vaults
      SET revision_at = max(personal_vaults.revision_at + 1, l.revision_at + 1, ?)
      FROM personal_vault_logins l JOIN (${authorization.query}) v ON l.vault_id = v.id
      WHERE personal_vaults.id = v.id AND l.id = ? AND ${filter}
    `,
      )
      .bind(now, ...scope, id, ...filterParams),
    db
      .prepare(
        `
      UPDATE personal_vault_logins AS l
      SET ${assignment}, revision_at = v.revision_at
      FROM (${authorization.query}) v
      WHERE l.vault_id = v.id AND l.id = ? AND ${filter}
      RETURNING ${personalItemColumns("personal_vault_logins")}
    `,
      )
      .bind(...values, ...scope, id, ...filterParams),
    currentItem(db, authorization.query).bind(...scope, id),
  ]);
  const row = updated?.results[0];
  if (row?.id != null)
    return { status: "updated", item: decodeStoredItem(row) } as const;
  const visible = current?.results[0];
  if (!visible) return { status: "unauthorized" } as const;
  if (visible.id === null) return { status: "not_found" } as const;
  // A retry in the requested state succeeds without changing revisions.
  if (!editing) {
    const inTrash = visible.deletedAt !== null;
    return inTrash === (change.kind === "delete")
      ? ({ status: "updated", item: decodeStoredItem(visible) } as const)
      : ({ status: "conflict" } as const);
  }
  if (visible.type !== type) return { status: "type_mismatch" } as const;
  if (visible.deletedAt !== null) return { status: "trashed" } as const;
  // A browser retry submits the same ciphertext after a lost response.
  if (change.kind === "edit_note") {
    const item = decodeStoredItem(visible);
    if (
      item.name === change.name &&
      (item.details.notes ?? null) === change.notes
    )
      return { status: "updated", item } as const;
  }
  if (change.kind === "edit" && change.alreadyApplied) {
    const item = decodeStoredItem(visible);
    if (change.alreadyApplied(item))
      return { status: "updated", item } as const;
  }
  return { status: "conflict" } as const;
};

export const editPersonalItem = async (
  db: WorkerEnv["DB"],
  authorization: VaultAuthorization,
  id: string,
  edit: Pick<EncryptedItem, "type" | "name" | "details"> & {
    wrappedKey?: string;
    expectedRevision: number;
    keepPasswordHistory?: boolean;
  },
) => {
  const now = Date.now();
  const row = await currentItem(db, authorization.query)
    .bind(...authorization.parameters(now), id)
    .first<StoredPersonalItem | { id: null }>();
  if (!row) return { status: "unauthorized" } as const;
  if (row.id === null) return { status: "not_found" } as const;
  const item = decodeStoredItem(row);
  if (item.type !== edit.type) return { status: "type_mismatch" } as const;
  if (item.deletedAt !== null) return { status: "trashed" } as const;

  const wrappedKey = edit.wrappedKey ?? item.wrappedKey;
  const old = wrappedKey === item.wrappedKey ? item.details : {};
  let details = {
    ...old,
    ...edit.details,
    ...(edit.details.credentials && {
      credentials: { ...old.credentials, ...edit.details.credentials },
    }),
    ...(edit.details.data && { data: { ...old.data, ...edit.details.data } }),
  };
  const matches = (current: PersonalItem) =>
    current.name === edit.name &&
    current.wrappedKey === wrappedKey &&
    JSON.stringify(current.details) === JSON.stringify(details);
  if (edit.keepPasswordHistory && matches(item))
    return { status: "updated", item } as const;
  if (item.revisionAt !== edit.expectedRevision)
    return { status: "conflict" } as const;
  const previousPassword = old.credentials?.password;
  const newPassword = details.credentials?.password;
  if (
    edit.keepPasswordHistory &&
    previousPassword != null &&
    previousPassword !== newPassword
  ) {
    const changedAt = new Date(now).toISOString();
    details = {
      ...details,
      credentials: { ...details.credentials, passwordRevisionDate: changedAt },
      passwordHistory: [
        { password: previousPassword, lastUsedDate: changedAt },
        ...(details.passwordHistory ?? []).slice(0, 4),
      ],
    };
  }
  return changePersonalItem(db, authorization, id, {
    kind: "edit",
    expectedRevision: edit.expectedRevision,
    item: { name: edit.name, wrappedKey, ...itemContent(item.type, details) },
    alreadyApplied: edit.keepPasswordHistory ? matches : undefined,
  });
};

type LoginEdit = Omit<typeof EditVaultLogin.Type, "keyId" | "type">;

const loginEditMatches = (item: PersonalItem, edit: LoginEdit) => {
  if (item.type !== 1) return false;
  const { username, password, uris } = item.details.credentials;
  if (
    item.name !== edit.name ||
    (username ?? null) !== edit.username ||
    (password ?? null) !== edit.password
  )
    return false;
  if (!edit.website) return true;
  const { previousUri, replacement } = edit.website;
  const primary = uris?.find(({ uri }) => uri !== null);
  if (!replacement)
    return previousUri === null
      ? !primary
      : !uris?.some(({ uri }) => uri === previousUri);
  return (
    primary?.uri === replacement.uri &&
    primary.uriChecksum === replacement.uriChecksum &&
    primary.match === hostUriMatch
  );
};

export const editPersonalLogin = async (
  db: WorkerEnv["DB"],
  authorization: VaultAuthorization,
  id: string,
  edit: LoginEdit,
) => {
  const now = Date.now();
  const row = await currentItem(db, authorization.query)
    .bind(...authorization.parameters(now), id)
    .first<StoredPersonalItem | { id: null }>();
  if (!row) return { status: "unauthorized" } as const;
  if (row.id === null) return { status: "not_found" } as const;
  const item = decodeStoredItem(row);
  if (item.type !== 1) return { status: "type_mismatch" } as const;
  if (item.deletedAt !== null) return { status: "trashed" } as const;
  if (loginEditMatches(item, edit)) return { status: "updated", item } as const;
  if (item.revisionAt !== edit.expectedRevision)
    return { status: "conflict" } as const;

  const { name, username, password, website } = edit;
  const details = {
    ...item.details,
    credentials: { ...item.details.credentials, username, password },
  };
  if (website) {
    const uris = [...(details.credentials.uris ?? [])];
    const primary = uris.findIndex(({ uri }) => uri !== null);
    if ((uris[primary]?.uri ?? null) !== website.previousUri)
      return { status: "conflict" } as const;
    const { replacement } = website;
    if (replacement)
      uris.splice(Math.max(primary, 0), 1, {
        ...replacement,
        match: hostUriMatch,
      });
    else if (primary !== -1) uris.splice(primary, 1);
    details.credentials.uris = uris;
  }
  const previousPassword = item.details.credentials.password;
  if (previousPassword != null && previousPassword !== password) {
    const changedAt = new Date(now).toISOString();
    details.credentials.passwordRevisionDate = changedAt;
    details.passwordHistory = [
      { password: previousPassword, lastUsedDate: changedAt },
      ...(details.passwordHistory ?? []).slice(0, 4),
    ];
  }
  return changePersonalItem(db, authorization, id, {
    kind: "edit",
    expectedRevision: edit.expectedRevision,
    item: { type: 1, name, wrappedKey: item.wrappedKey, details },
    alreadyApplied: (latest) => loginEditMatches(latest, edit),
  });
};
