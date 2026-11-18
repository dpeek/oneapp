import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import {
  decodeStoredItem,
  personalItemColumns,
  type StoredPersonalItem,
  type VaultAuthorization,
} from "./personal.ts";

type DB = WorkerEnv["DB"];
type Selection = readonly { id: string; revision?: number }[];
type Action =
  | { kind: "trash" | "restore" | "archive" | "unarchive" | "purge" }
  | { kind: "move"; folderId: string | null };

const operations = {
  trash: {
    applied: "i.deleted_at IS NOT NULL",
    available: "true",
    set: "deleted_at = v.revision_at",
  },
  restore: {
    applied: "i.deleted_at IS NULL",
    available: "true",
    set: "deleted_at = NULL",
  },
  archive: {
    applied: "i.archived_at IS NOT NULL",
    available: "i.deleted_at IS NULL",
    set: "archived_at = v.revision_at",
  },
  unarchive: {
    applied: "i.archived_at IS NULL",
    available: "i.deleted_at IS NULL",
    set: "archived_at = NULL",
  },
  purge: {
    applied: "i.id IS NULL AND d.id IS NOT NULL",
    available: "i.deleted_at IS NOT NULL",
    set: "",
  },
  move: {
    applied: "i.folder_id IS (SELECT folder_id FROM target)",
    available: "i.deleted_at IS NULL",
    set: "folder_id = (SELECT folder_id FROM target)",
  },
} as const;

export const changeItemSelection = async (
  db: DB,
  authorization: VaultAuthorization,
  selection: Selection,
  action: Action,
) => {
  const now = Date.now();
  const operation = operations[action.kind];
  const folderId = action.kind === "move" ? action.folderId : null;
  const state = `WITH target(folder_id) AS (VALUES (?)),
    v AS (${authorization.query}),
    selected AS (
      SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.revision') AS revision
      FROM json_each(?)
    ),
    candidate AS (
      SELECT s.id, CASE
        WHEN i.id IS NULL AND NOT (${action.kind === "purge" ? operation.applied : "false"}) THEN 'missing'
        WHEN (${operation.applied}) AND (i.id IS NULL OR ${operation.available}) THEN 'done'
        WHEN i.id IS NOT NULL AND (${operation.available}) AND (s.revision IS NULL OR i.revision_at = s.revision) THEN 'change'
        ELSE 'conflict'
      END AS status
      FROM v CROSS JOIN selected s
      LEFT JOIN personal_vault_logins i ON i.vault_id = v.id AND i.id = s.id
      LEFT JOIN personal_vault_deleted_items d ON d.vault_id = v.id AND d.id = s.id
    ),
    invalid_folder AS (
      SELECT 1 FROM v, target WHERE target.folder_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM personal_vault_folders f WHERE f.vault_id = v.id AND f.id = target.folder_id
      )
    ),
    changes AS (
      SELECT id FROM candidate
      WHERE status = 'change' AND NOT EXISTS (SELECT 1 FROM candidate WHERE status IN ('missing', 'conflict'))
        AND NOT EXISTS (SELECT 1 FROM invalid_folder)
    )`;
  const bind = [
    folderId,
    ...authorization.parameters(now),
    JSON.stringify(selection),
  ];
  const advance = db
    .prepare(
      `${state}
    UPDATE personal_vaults SET revision_at = max(revision_at + 1, ?)
    WHERE id IN (SELECT id FROM v) AND EXISTS (SELECT 1 FROM changes)`,
    )
    .bind(...bind, now);
  const write =
    action.kind === "purge"
      ? [
          db
            .prepare(
              `${state} INSERT INTO personal_vault_deleted_items (id, vault_id)
          SELECT changes.id, v.id FROM changes, v WHERE true ON CONFLICT(id) DO NOTHING`,
            )
            .bind(...bind),
          db
            .prepare(
              `${state} DELETE FROM personal_vault_logins
          WHERE id IN (SELECT id FROM changes) AND vault_id IN (SELECT id FROM v)`,
            )
            .bind(...bind),
        ]
      : [
          db
            .prepare(
              `${state} UPDATE personal_vault_logins AS i
      SET ${operation.set}, revision_at = v.revision_at FROM v
      WHERE i.vault_id = v.id AND i.id IN (SELECT id FROM changes)`,
            )
            .bind(...bind),
        ];
  const rows = await db.batch<StoredPersonalItem & { state: string }>([
    advance,
    ...write,
    db
      .prepare(
        `${state}
      SELECT ${personalItemColumns("i")},
        CASE WHEN EXISTS (SELECT 1 FROM invalid_folder) THEN 'missing' ELSE c.status END AS state
      FROM v, candidate c
      LEFT JOIN personal_vault_logins i ON i.vault_id = v.id AND i.id = c.id
      ORDER BY c.id`,
      )
      .bind(...bind),
  ]);
  const result: (StoredPersonalItem & { state: string })[] =
    rows[rows.length - 1]?.results ?? [];
  if (result.length === 0) return { status: "unauthorized" } as const;
  if (result.some(({ state }) => state === "missing"))
    return { status: "not_found" } as const;
  if (result.some(({ state }) => state === "conflict"))
    return { status: "conflict" } as const;
  return {
    status: "updated",
    items: result
      .filter(({ id }) => id !== null)
      .map(({ state: _, ...item }) => decodeStoredItem(item)),
  } as const;
};
