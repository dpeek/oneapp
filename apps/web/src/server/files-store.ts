import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { FileTagUpdate, StoredFile } from "../files-contract.ts";
import type { Tag } from "../items-contract.ts";
import {
  claimed,
  deleteTags,
  incrementItemVersion,
  insertTags,
  itemTagIdsColumn,
  itemVersionStatement,
  tagCatalog,
  tagsAreAvailable,
} from "./items-store.ts";

type FileRow = Omit<StoredFile, "tagIds"> & { tagIds: string };

const fileProjection = `
  SELECT i.id, i.title AS name, i.revision, i.created_at AS createdAt,
    f.media_type AS mediaType, f.size, f.preview_type AS previewType, ${itemTagIdsColumn}
  FROM items i JOIN files f ON f.account_id = i.account_id AND f.item_id = i.id
  WHERE i.account_id = ?1 AND i.kind = 'file'`;
const fileStatement = (db: D1Database, account: string, id: string) =>
  db.prepare(`${fileProjection} AND i.id = ?2`).bind(account, id);
const decodeFile = ({ tagIds, ...file }: FileRow): StoredFile => ({
  ...file,
  tagIds: JSON.parse(tagIds) as readonly string[],
});

export const fileObjectKey = (account: string, id: string) =>
  `${account}/${id}`;

export const getFile = async (db: D1Database, account: string, id: string) => {
  const row = await fileStatement(db, account, id).first<FileRow>();
  return row ? decodeFile(row) : null;
};

const versionStatement = (db: D1Database, account: string) =>
  itemVersionStatement(db, "file", account);

export const fileVersion = async (db: D1Database, account: string) =>
  (await versionStatement(db, account).first<number>("version")) ?? 0;

export const fileIndex = async (db: D1Database, account: string) => {
  const [fileRows, tagRows, versionRows] = await db.batch<
    FileRow | Tag | { version: number }
  >([
    db
      .prepare(`${fileProjection} ORDER BY i.created_at DESC, i.id DESC`)
      .bind(account),
    tagCatalog(db, account),
    versionStatement(db, account),
  ]);
  return {
    files: (fileRows!.results as FileRow[]).map(decodeFile),
    tags: tagRows!.results as Tag[],
    version:
      (versionRows!.results[0] as { version: number } | undefined)?.version ??
      0,
  };
};

export const createFile = async (
  db: D1Database,
  bucket: R2Bucket,
  account: string,
  metadata: Pick<StoredFile, "name" | "mediaType" | "previewType">,
  bytes: ArrayBuffer,
  now: number,
): Promise<StoredFile> => {
  const id = crypto.randomUUID();
  const revision = crypto.randomUUID();
  const key = fileObjectKey(account, id);
  const size = bytes.byteLength;
  const stored = await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (!stored) throw new Error("Could not reserve an upload key.");
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO items (account_id, id, kind, title, revision, created_at, updated_at)
         VALUES (?, ?, 'file', ?, ?, ?, ?)`,
        )
        .bind(account, id, metadata.name, revision, now, now),
      db
        .prepare(
          `INSERT INTO files (account_id, item_id, media_type, size, preview_type)
         VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(account, id, metadata.mediaType, size, metadata.previewType),
      incrementItemVersion(db, "file", "changes() = 1").bind(account),
    ]);
  } catch (error) {
    // An interrupted response can leave a committed batch. Check before deleting its bytes.
    const saved = await getFile(db, account, id);
    if (saved) return saved;
    await bucket.delete(key);
    throw error;
  }
  return { ...metadata, id, revision, size, createdAt: now, tagIds: [] };
};

export const updateFileTags = async (
  db: D1Database,
  account: string,
  id: string,
  input: typeof FileTagUpdate.Type,
  now: number,
) => {
  const revision = crypto.randomUUID();
  const tagIds = JSON.stringify([...new Set(input.tagIds)]);
  const [item, , , , file] = await db.batch<FileRow>([
    db
      .prepare(
        `UPDATE items SET revision = ?4, updated_at = ?5
       WHERE account_id = ?1 AND id = ?2 AND revision = ?3 AND kind = 'file'
       AND EXISTS (SELECT 1 FROM files WHERE account_id = ?1 AND item_id = ?2)
       AND ${tagsAreAvailable("?6")}`,
      )
      .bind(account, id, input.revision, revision, now, tagIds),
    deleteTags(db, account, id, revision),
    insertTags(db, account, id, revision, tagIds),
    incrementItemVersion(db, "file", claimed).bind(account, id, revision),
    fileStatement(db, account, id),
  ]);
  const row = file!.results[0];
  return {
    changed: item!.meta.changes > 0,
    file: row ? decodeFile(row) : null,
  };
};
