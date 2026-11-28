import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  fileImageKey,
  fileImagesApi,
  type FileDocument,
  type FileDocumentUpdate,
  type FileTagUpdate,
  type StoredFile,
} from "../files-contract.ts";
import { markdownImageIds } from "../markdown-images.ts";
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

type FileRow = Omit<StoredFile, "tagIds" | "authored"> & {
  tagIds: string;
  documentKey: string | null;
};
type FileWithTagsRow = Omit<FileRow, "tagIds"> & { tags: string };

const fileColumns = `i.id, i.title AS name, i.revision, i.created_at AS createdAt,
  f.media_type AS mediaType, f.size, f.preview_type AS previewType, f.document_key AS documentKey`;
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
const decodeFile = ({ tagIds, documentKey, ...file }: FileRow): StoredFile => ({
  ...file,
  authored: documentKey !== null,
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
  return {
    ...metadata,
    id,
    revision,
    size,
    createdAt: now,
    tagIds: [],
    authored: false,
  };
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

const objectLifetime = 60 * 60_000;
const markdownType = "text/markdown";
const documentKey = (account: string, id: string, revision: string) =>
  `documents/${account}/${id}/${revision}.md`;

const reserveObject = async (
  db: D1Database,
  bucket: R2Bucket,
  account: string,
  id: string,
  key: string,
  kind: "body" | "image",
  mediaType: string,
  bytes: Uint8Array | ArrayBuffer,
  now: number,
) => {
  const reserved = await db
    .prepare(
      `INSERT INTO file_objects (key, account_id, item_id, kind, state, expires_at)
       SELECT ?1, ?2, ?3, ?4, 'pending', ?5
       WHERE ?4 = 'body' OR EXISTS (
         SELECT 1 FROM files WHERE account_id = ?2 AND item_id = ?3 AND document_key IS NOT NULL
       )
       ON CONFLICT DO NOTHING`,
    )
    .bind(key, account, id, kind, now + objectLifetime)
    .run();
  if (!reserved.meta.changes) return false;
  const stored = await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: mediaType },
  });
  if (!stored) throw new Error("Could not reserve a document object.");
  return true;
};

export const createDocument = async (
  db: D1Database,
  bucket: R2Bucket,
  account: string,
  now: number,
): Promise<FileDocument> => {
  const id = crypto.randomUUID();
  const revision = crypto.randomUUID();
  const key = documentKey(account, id, revision);
  const title = "Untitled document";
  if (
    !(await reserveObject(
      db,
      bucket,
      account,
      id,
      key,
      "body",
      markdownType,
      new Uint8Array(),
      now,
    ))
  )
    throw new Error("Could not reserve the document body.");
  await db.batch([
    db
      .prepare(
        `INSERT INTO items (account_id, id, kind, title, revision, created_at, updated_at)
       SELECT ?1, ?2, 'file', ?3, ?4, ?5, ?5
       WHERE EXISTS (SELECT 1 FROM file_objects WHERE key = ?6 AND state = 'pending')`,
      )
      .bind(account, id, title, revision, now, key),
    db
      .prepare(
        `INSERT INTO files (account_id, item_id, media_type, size, document_key)
       SELECT ?1, ?2, ?4, 0, ?5 WHERE ${claimed}`,
      )
      .bind(account, id, revision, markdownType, key),
    db
      .prepare(
        `UPDATE file_objects SET state = 'live', expires_at = NULL
       WHERE key = ?4 AND ${claimed}`,
      )
      .bind(account, id, revision, key),
    incrementItemVersion(db, "file", claimed).bind(account, id, revision),
  ]);
  const file = await getFile(db, account, id);
  if (!file) throw new Error("Could not create the document.");
  return { file, markdown: "" };
};

export const readDocument = async (
  db: D1Database,
  bucket: R2Bucket,
  account: string,
  id: string,
): Promise<FileDocument | null> => {
  const row = await fileStatement(db, account, id).first<FileRow>();
  if (!row?.documentKey) return null;
  const object = await bucket.get(row.documentKey);
  if (!object) throw new Error("The document body is unavailable.");
  const markdown = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    await object.arrayBuffer(),
  );
  return { file: decodeFile(row), markdown };
};

export const updateDocument = async (
  db: D1Database,
  bucket: R2Bucket,
  account: string,
  id: string,
  input: typeof FileDocumentUpdate.Type,
  now: number,
) => {
  const row = await fileStatement(db, account, id).first<FileRow>();
  if (!row?.documentKey) return "missing";
  if (row.revision !== input.revision) return "conflict";

  const revision = crypto.randomUUID();
  const key = documentKey(account, id, revision);
  const bytes = new TextEncoder().encode(input.markdown);
  const linked = JSON.stringify(
    [...markdownImageIds(input.markdown, fileImagesApi(id))].map((image) =>
      fileImageKey(account, id, image),
    ),
  );
  if (
    !(await reserveObject(
      db,
      bucket,
      account,
      id,
      key,
      "body",
      markdownType,
      bytes,
      now,
    ))
  )
    throw new Error("Could not reserve the document body.");

  const [item, , , , , saved] = await db.batch<FileRow>([
    db
      .prepare(
        `UPDATE items SET revision = ?4, title = ?5, updated_at = ?6
       WHERE account_id = ?1 AND id = ?2 AND revision = ?3
         AND EXISTS (SELECT 1 FROM file_objects WHERE key = ?7 AND state = 'pending')
         AND NOT EXISTS (
           SELECT 1 FROM json_each(?8) AS linked
           WHERE NOT EXISTS (
             SELECT 1 FROM file_objects WHERE key = linked.value AND state IN ('staged', 'live')
           )
         )`,
      )
      .bind(
        account,
        id,
        input.revision,
        revision,
        input.title,
        now,
        key,
        linked,
      ),
    db
      .prepare(
        `UPDATE files SET document_key = ?4, size = ?5
       WHERE account_id = ?1 AND item_id = ?2 AND ${claimed}`,
      )
      .bind(account, id, revision, key, bytes.byteLength),
    db
      .prepare(
        `UPDATE file_objects
       SET state = 'live', expires_at = NULL
       WHERE account_id = ?1 AND item_id = ?2 AND ${claimed}
         AND (key = ?4 OR key IN (SELECT value FROM json_each(?5)))`,
      )
      .bind(account, id, revision, key, linked),
    db
      .prepare(
        `UPDATE file_objects SET expires_at = ?6
       WHERE account_id = ?1 AND item_id = ?2 AND ${claimed}
         AND state = 'live' AND expires_at IS NULL AND key <> ?4
         AND key NOT IN (SELECT value FROM json_each(?5))`,
      )
      .bind(account, id, revision, key, linked, now + objectLifetime),
    incrementItemVersion(db, "file", claimed).bind(account, id, revision),
    fileStatement(db, account, id),
  ]);
  const current = saved!.results[0];
  if (!current) return "missing";
  if (!item!.meta.changes)
    return current.revision === input.revision
      ? "image_unavailable"
      : "conflict";
  return { file: decodeFile(current), markdown: input.markdown };
};

export const createDocumentImage = async (
  db: D1Database,
  bucket: R2Bucket,
  account: string,
  id: string,
  image: string,
  mediaType: string,
  bytes: ArrayBuffer,
  now: number,
) => {
  const key = fileImageKey(account, id, image);
  if (
    !(await reserveObject(
      db,
      bucket,
      account,
      id,
      key,
      "image",
      mediaType,
      bytes,
      now,
    ))
  )
    return false;
  const saved = await db
    .prepare(
      `UPDATE file_objects SET state = 'staged'
     WHERE key = ?3 AND state = 'pending' AND EXISTS (
       SELECT 1 FROM files WHERE account_id = ?1 AND item_id = ?2 AND document_key IS NOT NULL
     ) RETURNING key`,
    )
    .bind(account, id, key)
    .first();
  return saved !== null;
};

export const readDocumentImage = async (
  db: D1Database,
  bucket: R2Bucket,
  account: string,
  id: string,
  image: string,
) => {
  const key = fileImageKey(account, id, image);
  const row = await db
    .prepare(
      `SELECT 1 FROM file_objects
     WHERE key = ?3 AND (state = 'staged' OR (state = 'live' AND expires_at IS NULL))
       AND EXISTS (SELECT 1 FROM files WHERE account_id = ?1 AND item_id = ?2 AND document_key IS NOT NULL)`,
    )
    .bind(account, id, key)
    .first();
  return row ? bucket.get(key) : null;
};

const purgeFileObjects = async (
  db: D1Database,
  bucket: R2Bucket,
  now: number,
  owner?: { account: string; id: string },
) => {
  const where = owner ? "AND account_id = ?2 AND item_id = ?3" : "";
  const query = db.prepare(
    `UPDATE file_objects SET state = 'removed'
     WHERE key IN (
       SELECT key FROM file_objects WHERE expires_at <= ?1 ${where}
       ORDER BY expires_at LIMIT 100
     ) RETURNING key`,
  );
  const { results } = await (
    owner ? query.bind(now, owner.account, owner.id) : query.bind(now)
  ).all<{ key: string }>();
  if (!results.length) return;
  await bucket.delete(results.map(({ key }) => key));
  await db.batch(
    results.map(({ key }) =>
      db
        .prepare("DELETE FROM file_objects WHERE key = ? AND state = 'removed'")
        .bind(key),
    ),
  );
};

export const collectFileObjects = (db: D1Database, bucket: R2Bucket) =>
  purgeFileObjects(db, bucket, Date.now());

export const deleteFile = async (
  db: D1Database,
  bucket: R2Bucket,
  account: string,
  id: string,
  revision: string,
  now: number,
) => {
  const [, , removed, , current] = await db.batch<FileRow>([
    db
      .prepare(
        `INSERT INTO file_objects (key, account_id, item_id, kind, state, expires_at)
       SELECT ?4, ?1, ?2, 'upload', 'removed', ?5 FROM files
       WHERE account_id = ?1 AND item_id = ?2 AND document_key IS NULL AND ${claimed}
       ON CONFLICT DO NOTHING`,
      )
      .bind(account, id, revision, fileObjectKey(account, id), now),
    db
      .prepare(
        `UPDATE file_objects SET expires_at = ?4
       WHERE account_id = ?1 AND item_id = ?2 AND ${claimed}
         AND state <> 'pending'`,
      )
      .bind(account, id, revision, now),
    db
      .prepare(
        `DELETE FROM items WHERE account_id = ? AND id = ? AND revision = ? AND kind = 'file'`,
      )
      .bind(account, id, revision),
    incrementItemVersion(db, "file", "changes() = 1").bind(account),
    fileStatement(db, account, id),
  ]);
  if (!removed!.meta.changes) {
    const row = current!.results[0];
    return row ? decodeFile(row) : null;
  }
  await purgeFileObjects(db, bucket, now, { account, id }).catch(() =>
    console.warn("Could not collect deleted file objects"),
  );
  return "deleted";
};
