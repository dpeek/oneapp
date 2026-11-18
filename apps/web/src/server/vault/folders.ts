import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import { digest } from "../digest.ts";
import type { VaultAuthorization } from "./personal.ts";
import type { personalVaultFolders } from "./tables.ts";

type DB = WorkerEnv["DB"];
export type PersonalFolder = Omit<
  typeof personalVaultFolders.$inferSelect,
  "createDigest"
>;
const columns = (table: string) =>
  `${table}.id, ${table}.vault_id AS vaultId, ${table}.name, ${table}.revision_at AS revisionAt`;

export const readFolders = async (db: DB, vaultId: string) =>
  (
    await db
      .prepare(
        `SELECT ${columns("f")} FROM personal_vault_folders f WHERE f.vault_id = ? ORDER BY f.id`,
      )
      .bind(vaultId)
      .all<PersonalFolder>()
  ).results;

export const readFolder = (db: DB, vaultId: string, id: string) =>
  db
    .prepare(
      `SELECT ${columns("f")} FROM personal_vault_folders f WHERE f.vault_id = ? AND f.id = ?`,
    )
    .bind(vaultId, id)
    .first<PersonalFolder>();

export const createFolder = async (
  db: DB,
  authorization: VaultAuthorization,
  name: string,
) => {
  const createDigest = await digest(name);
  const now = Date.now();
  const id = crypto.randomUUID();
  const scope = authorization.parameters(now);
  const [, , saved] = await db.batch<PersonalFolder>([
    db
      .prepare(
        `INSERT INTO personal_vault_folders (id, vault_id, name, revision_at, create_digest)
       SELECT ?, v.id, ?, max(v.revision_at + 1, ?), ?
       FROM (${authorization.query}) v WHERE true
       ON CONFLICT (vault_id, create_digest) DO NOTHING`,
      )
      .bind(id, name, now, createDigest, ...scope),
    db
      .prepare(
        `UPDATE personal_vaults SET revision_at = f.revision_at
       FROM personal_vault_folders f WHERE f.id = ? AND f.vault_id = personal_vaults.id`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT ${columns("f")} FROM personal_vault_folders f
       JOIN (${authorization.query}) v ON v.id = f.vault_id WHERE f.create_digest = ?`,
      )
      .bind(...scope, createDigest),
  ]);
  return saved?.results[0] ?? null;
};

type FolderChange =
  | { kind: "rename"; name: string; expectedRevision?: number }
  | { kind: "delete"; expectedRevision?: number };

export const changeFolder = async (
  db: DB,
  authorization: VaultAuthorization,
  id: string,
  change: FolderChange,
) => {
  const now = Date.now();
  const scope = authorization.parameters(now);
  const expected = change.expectedRevision ?? null;
  const eligible = `(${authorization.query}) v JOIN personal_vault_folders f
    ON f.vault_id = v.id AND f.id = ? AND (? IS NULL OR f.revision_at = ?)`;
  const bind = [...scope, id, expected, expected];
  const rename = change.kind === "rename";
  const currentFolder = db
    .prepare(
      `SELECT ${columns("f")} FROM (${authorization.query}) v
     LEFT JOIN personal_vault_folders f ON f.vault_id = v.id AND f.id = ?`,
    )
    .bind(...scope, id);
  const [, , changed, current] = await db.batch<PersonalFolder | { id: null }>([
    db
      .prepare(
        `UPDATE personal_vaults SET revision_at = max(personal_vaults.revision_at + 1, ?)
       FROM ${eligible} WHERE personal_vaults.id = v.id${rename ? " AND f.name IS NOT ?" : ""}`,
      )
      .bind(now, ...bind, ...(rename ? [change.name] : [])),
    rename
      ? db.prepare("SELECT NULL WHERE false").bind()
      : db
          .prepare(
            `UPDATE personal_vault_logins AS i SET folder_id = NULL, revision_at = v.revision_at
         FROM ${eligible} WHERE i.vault_id = v.id AND i.folder_id = f.id`,
          )
          .bind(...bind),
    rename
      ? db
          .prepare(
            `UPDATE personal_vault_folders AS folder SET name = ?, revision_at = v.revision_at
         FROM ${eligible} WHERE folder.id = f.id AND folder.name IS NOT ?
         RETURNING ${columns("personal_vault_folders")}`,
          )
          .bind(change.name, ...bind, change.name)
      : db
          .prepare(
            `DELETE FROM personal_vault_folders WHERE id IN (SELECT f.id FROM ${eligible})
         RETURNING ${columns("personal_vault_folders")}`,
          )
          .bind(...bind),
    currentFolder,
  ]);
  const saved = changed?.results[0];
  if (saved?.id != null) return { status: "updated", folder: saved } as const;
  const visible = current?.results[0];
  if (!visible) return { status: "unauthorized" } as const;
  if (visible.id === null) return { status: "not_found" } as const;
  if (rename && visible.name === change.name)
    return { status: "updated", folder: visible } as const;
  return { status: "conflict" } as const;
};

export const projectFolder = (folder: PersonalFolder) => ({
  id: folder.id,
  name: folder.name,
  revision: folder.revisionAt,
});
