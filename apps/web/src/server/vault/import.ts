import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import { digest } from "../digest.ts";
import type { EncryptedItem, VaultAuthorization } from "./personal.ts";

export type PersonalImport = {
  folders: { name: string; id?: string | null }[];
  items: (EncryptedItem & {
    folderIndex?: number;
    archivedAt?: number | null;
  })[];
};

export const importPersonalVault = async (
  db: WorkerEnv["DB"],
  authorization: VaultAuthorization,
  { folders, items }: PersonalImport,
) => {
  const operation = await digest(JSON.stringify([folders, items]));
  const id = crypto.randomUUID();
  const now = Date.now();
  const scope = authorization.parameters(now);
  const folderRows = folders.map((folder) => ({
    id: crypto.randomUUID(),
    name: folder.name,
    source: folder.id ?? null,
  }));
  const itemRows = items.map(
    ({ type, name, wrappedKey, details, folderIndex, archivedAt }) => ({
      id: crypto.randomUUID(),
      type,
      name,
      wrappedKey,
      details,
      archivedAt: archivedAt ?? null,
      folder:
        folderIndex === undefined
          ? null
          : {
              id: folderRows[folderIndex]?.id,
              source: folderRows[folderIndex]?.source,
            },
    }),
  );
  const current = `(${authorization.query}) v
    JOIN personal_vault_imports t ON t.vault_id = v.id AND t.id = ?`;

  // D1 runs the claim, revision and row inserts as one transaction. Only the
  // batch that owns the operation ID can insert rows. Any failure releases it.
  const results = await db.batch<{ id: string }>([
    db
      .prepare(
        `INSERT INTO personal_vault_imports (id, vault_id, digest)
       SELECT ?, v.id, ? FROM (${authorization.query}) v WHERE true
       ON CONFLICT (vault_id, digest) DO NOTHING`,
      )
      .bind(id, operation, ...scope),
    db
      .prepare(
        `UPDATE personal_vaults SET revision_at = max(personal_vaults.revision_at + 1, ?)
       FROM ${current} WHERE personal_vaults.id = v.id`,
      )
      .bind(now, ...scope, id),
    db
      .prepare(
        `INSERT INTO personal_vault_folders (id, vault_id, name, revision_at)
       SELECT json_extract(f.value, '$.id'), v.id, json_extract(f.value, '$.name'), v.revision_at
       FROM ${current}, json_each(?) f
       WHERE NOT EXISTS (
         SELECT 1 FROM personal_vault_folders old WHERE old.vault_id = v.id AND old.id = json_extract(f.value, '$.source')
       )`,
      )
      .bind(...scope, id, JSON.stringify(folderRows)),
    db
      .prepare(
        `INSERT INTO personal_vault_logins (id, vault_id, name, wrapped_key, details, created_at, revision_at, type, folder_id, archived_at)
       SELECT json_extract(i.value, '$.id'), v.id, json_extract(i.value, '$.name'),
         json_extract(i.value, '$.wrappedKey'), json_extract(i.value, '$.details'), ?, v.revision_at,
         json_extract(i.value, '$.type'), coalesce(existing.id, json_extract(i.value, '$.folder.id')),
         json_extract(i.value, '$.archivedAt')
       FROM ${current}, json_each(?) i
       LEFT JOIN personal_vault_folders existing ON existing.vault_id = v.id AND existing.id = json_extract(i.value, '$.folder.source')`,
      )
      .bind(now, ...scope, id, JSON.stringify(itemRows)),
    db
      .prepare(
        `SELECT t.id FROM (${authorization.query}) v
       JOIN personal_vault_imports t ON t.vault_id = v.id WHERE t.digest = ?`,
      )
      .bind(...scope, operation),
  ]);
  return results[4]?.results[0]
    ? { items: items.length, folders: folders.length }
    : null;
};
