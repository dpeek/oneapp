import type { D1Database } from "@cloudflare/workers-types";
import { Schema } from "effect";
import {
  normalizeTagName,
  tagNameKey,
  TagName,
  type Tag,
} from "../items-contract.ts";

export const itemTagIdsColumn = `(
  SELECT json_group_array(tag_id)
  FROM item_tags WHERE account_id = i.account_id AND item_id = i.id
) AS tagIds`;

const tagProjection = "SELECT id, name FROM tags WHERE account_id = ?1";
export const tagCatalog = (db: D1Database, account: string) =>
  db.prepare(`${tagProjection} ORDER BY name_key`).bind(account);

export const listTags = async (
  db: D1Database,
  account: string,
  query: string,
  limit: number,
  offset: number,
) => {
  const { results } = await db
    .prepare(
      `${tagProjection} AND instr(name_key, ?2) > 0 ORDER BY name_key LIMIT ?3 OFFSET ?4`,
    )
    .bind(account, tagNameKey(query), limit, offset)
    .all<Tag>();
  return results;
};

export const tagsAreAvailable = (idsParameter: string) => `NOT EXISTS (
  SELECT 1 FROM json_each(${idsParameter}) AS requested
  WHERE NOT EXISTS (SELECT 1 FROM tags WHERE account_id = ?1 AND id = requested.value)
)`;
// Subsequent statements can write only if this batch claimed the item's revision.
export const claimed = `EXISTS (
  SELECT 1 FROM items WHERE account_id = ?1 AND id = ?2 AND revision = ?3
)`;
export const insertTags = (
  db: D1Database,
  account: string,
  id: string,
  revision: string,
  tagIds: string,
) =>
  db
    .prepare(
      `INSERT INTO item_tags (account_id, item_id, tag_id)
      SELECT ?1, ?2, value FROM json_each(?4) WHERE ${claimed}`,
    )
    .bind(account, id, revision, tagIds);

export const deleteTags = (
  db: D1Database,
  account: string,
  id: string,
  revision: string,
) =>
  db
    .prepare(
      `DELETE FROM item_tags WHERE account_id = ?1 AND item_id = ?2 AND ${claimed}`,
    )
    .bind(account, id, revision);

export const createTag = async (
  db: D1Database,
  account: string,
  input: string,
) => {
  const name = normalizeTagName(input);
  if (!Schema.is(TagName)(name)) return null;
  const nameKey = tagNameKey(name);
  const [, tag] = await db.batch<Tag>([
    db
      .prepare(
        `INSERT INTO tags (account_id, id, name, name_key) VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id, name_key) DO NOTHING`,
      )
      .bind(account, crypto.randomUUID(), name, nameKey),
    db
      .prepare(
        "SELECT id, name FROM tags WHERE account_id = ? AND name_key = ?",
      )
      .bind(account, nameKey),
  ]);
  return tag!.results[0]!;
};
