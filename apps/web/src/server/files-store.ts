import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { FileTagUpdate, StoredFile } from "../files-contract.ts";
import { type Tag, tagNameKey } from "../items-contract.ts";
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
type FileWithTagsRow = Omit<StoredFile, "tagIds"> & { tags: string };

const fileColumns = `i.id, i.title AS name, i.revision, i.created_at AS createdAt,
  f.media_type AS mediaType, f.size, f.preview_type AS previewType`;
const fileSource = `
  FROM items i JOIN files f ON f.account_id = i.account_id AND f.item_id = i.id
  WHERE i.account_id = ?1 AND i.kind = 'file'`;
const fileProjection = `SELECT ${fileColumns}, ${itemTagIdsColumn} ${fileSource}`;
const fileWithTagsProjection = `
  SELECT ${fileColumns}, (
    SELECT json_group_array(json_object('id', t.id, 'name', t.name) ORDER BY t.name_key)
    FROM item_tags it JOIN tags t ON t.account_id = it.account_id AND t.id = it.tag_id
    WHERE it.account_id = i.account_id AND it.item_id = i.id
  ) AS tags ${fileSource}`;
const fileOrder = "ORDER BY i.created_at DESC, i.id DESC";
const fileStatement = (db: D1Database, account: string, id: string) =>
  db.prepare(`${fileProjection} AND i.id = ?2`).bind(account, id);
const decodeFile = ({ tagIds, ...file }: FileRow): StoredFile => ({
  ...file,
  tagIds: JSON.parse(tagIds) as readonly string[],
});
const decodeFileWithTags = ({ tags, ...file }: FileWithTagsRow) => ({
  ...file,
  tags: JSON.parse(tags) as readonly Tag[],
});

export const fileObjectKey = (account: string, id: string) =>
  `${account}/${id}`;

export const getFile = async (db: D1Database, account: string, id: string) => {
  const row = await fileStatement(db, account, id).first<FileRow>();
  return row ? decodeFile(row) : null;
};

export const getFileWithTags = async (
  db: D1Database,
  account: string,
  id: string,
) => {
  const row = await db
    .prepare(`${fileWithTagsProjection} AND i.id = ?2`)
    .bind(account, id)
    .first<FileWithTagsRow>();
  return row ? decodeFileWithTags(row) : null;
};

export const searchFiles = async (
  db: D1Database,
  account: string,
  {
    query,
    tag,
    limit,
    offset,
  }: {
    query: string;
    tag?: string | undefined;
    limit: number;
    offset: number;
  },
) => {
  const { results } = await db
    .prepare(
      `${fileWithTagsProjection}
      AND instr(lower(i.title), lower(?2)) > 0
      AND (?3 IS NULL OR EXISTS (
        SELECT 1 FROM tags t JOIN item_tags it
          ON it.account_id = t.account_id AND it.tag_id = t.id
        WHERE t.account_id = i.account_id AND it.item_id = i.id AND t.name_key = ?3
      ))
      ${fileOrder} LIMIT ?4 OFFSET ?5`,
    )
    .bind(
      account,
      query,
      tag === undefined ? null : tagNameKey(tag),
      limit,
      offset,
    )
    .all<FileWithTagsRow>();
  return results.map(decodeFileWithTags);
};

const versionStatement = (db: D1Database, account: string) =>
  itemVersionStatement(db, "file", account);

export const fileVersion = async (db: D1Database, account: string) =>
  (await versionStatement(db, account).first<number>("version")) ?? 0;

export const fileIndex = async (db: D1Database, account: string) => {
  const [fileRows, tagRows, versionRows] = await db.batch<
    FileRow | Tag | { version: number }
  >([
    db.prepare(`${fileProjection} ${fileOrder}`).bind(account),
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
