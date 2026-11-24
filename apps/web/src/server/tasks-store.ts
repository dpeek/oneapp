import type { D1Database } from "@cloudflare/workers-types";
import { Schema } from "effect";
import { normalizeTagName, TagName, type Tag } from "../items-contract.ts";
import type {
  Task,
  TaskCreate,
  TaskFields,
  TaskUpdate,
} from "../tasks-contract.ts";

type TaskSummary = Omit<Task, "description">;
type TaskRow<T extends TaskSummary = Task> = Omit<T, "tagIds"> & {
  tagIds: string;
};
const taskColumns = `
  i.id, i.title, i.revision, i.created_at AS createdAt,
    i.updated_at AS updatedAt, t.status, t.priority, t.due_on AS dueOn,
    (
      SELECT json_group_array(tag_id)
      FROM item_tags WHERE account_id = i.account_id AND item_id = i.id
    ) AS tagIds`;
const taskSource = `
  FROM items i JOIN tasks t ON t.account_id = i.account_id AND t.item_id = i.id
  WHERE i.account_id = ?1 AND i.kind = 'task'`;
const taskProjection = `SELECT ${taskColumns}, t.description ${taskSource}`;
const taskOrder = "ORDER BY i.updated_at DESC, i.id DESC";
const tagProjection = "SELECT id, name FROM tags WHERE account_id = ?1";

const taskStatement = (db: D1Database, account: string, id: string) =>
  db.prepare(`${taskProjection} AND i.id = ?2`).bind(account, id);

const decodeTask = <T extends TaskRow<TaskSummary>>({
  tagIds,
  ...fields
}: T) => ({
  ...fields,
  tagIds: JSON.parse(tagIds) as readonly string[],
});

export const getTask = async (db: D1Database, account: string, id: string) => {
  const task = await taskStatement(db, account, id).first<TaskRow>();
  return task ? decodeTask(task) : null;
};

export const taskIndex = async (db: D1Database, account: string) => {
  const [taskRows, tagRows] = await db.batch<TaskRow | Tag>([
    db.prepare(`${taskProjection} ${taskOrder}`).bind(account),
    db.prepare(`${tagProjection} ORDER BY name_key`).bind(account),
  ]);
  return {
    tasks: (taskRows!.results as TaskRow[]).map(decodeTask),
    tags: tagRows!.results as Tag[],
  };
};

type TaskFilters = {
  query?: string | undefined;
  status?: "active" | "all" | Task["status"] | undefined;
  priority?: Task["priority"] | undefined;
  tagId?: string | undefined;
  dueOnOrAfter?: string | undefined;
  dueOnOrBefore?: string | undefined;
  limit: number;
  offset: number;
};

export const listTasks = async (
  db: D1Database,
  account: string,
  {
    query,
    status = "active",
    priority,
    tagId,
    dueOnOrAfter,
    dueOnOrBefore,
    limit,
    offset,
  }: TaskFilters,
) => {
  const filters: string[] = [];
  const parameters: Array<string | number | null> = [account];
  const filter = (sql: string, parameter: string | null) => {
    filters.push(sql);
    parameters.push(parameter);
  };
  if (query) filter("instr(lower(i.title), lower(?)) > 0", query);
  if (status === "active")
    filters.push(
      "(t.status IS NULL OR t.status NOT IN ('completed', 'canceled'))",
    );
  else if (status !== "all") filter("t.status IS ?", status);
  if (priority !== undefined) filter("t.priority IS ?", priority);
  if (tagId)
    filter(
      "EXISTS (SELECT 1 FROM item_tags WHERE account_id = i.account_id AND item_id = i.id AND tag_id = ?)",
      tagId,
    );
  if (dueOnOrAfter) filter("t.due_on >= ?", dueOnOrAfter);
  if (dueOnOrBefore) filter("t.due_on <= ?", dueOnOrBefore);
  const conditions = filters.map((clause) => `AND ${clause}`).join("\n");
  const { results } = await db
    .prepare(
      `SELECT ${taskColumns} ${taskSource} ${conditions} ${taskOrder} LIMIT ? OFFSET ?`,
    )
    .bind(...parameters, limit, offset)
    .all<TaskRow<TaskSummary>>();
  return results.map(decodeTask);
};

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
    .bind(account, normalizeTagName(query).toLowerCase(), limit, offset)
    .all<Tag>();
  return results;
};

const tagsAreAvailable = (idsParameter: string) => `NOT EXISTS (
  SELECT 1 FROM json_each(${idsParameter}) AS requested
  WHERE NOT EXISTS (SELECT 1 FROM tags WHERE account_id = ?1 AND id = requested.value)
)`;
// Subsequent statements can write only if this batch claimed the item's revision.
const claimed = `EXISTS (
  SELECT 1 FROM items WHERE account_id = ?1 AND id = ?2 AND revision = ?3
)`;
const insertTags = (
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

export const createTask = async (
  db: D1Database,
  account: string,
  {
    id,
    title,
    description = "",
    status = "not-started",
    priority = null,
    dueOn = null,
    tagIds = [],
  }: typeof TaskCreate.Type & Partial<typeof TaskFields.Type>,
  now: number,
) => {
  const revision = crypto.randomUUID();
  const ids = JSON.stringify([...new Set(tagIds)]);
  const [, , , task] = await db.batch<TaskRow>([
    db
      .prepare(
        `INSERT INTO items (account_id, id, kind, title, revision, created_at, updated_at)
         SELECT ?1, ?2, 'task', ?3, ?4, ?5, ?5 WHERE ${tagsAreAvailable("?6")}
         ON CONFLICT DO NOTHING`,
      )
      .bind(account, id, title, revision, now, ids),
    db
      .prepare(
        `INSERT INTO tasks (account_id, item_id, description, status, priority, due_on)
         SELECT ?1, ?2, ?4, ?5, ?6, ?7 WHERE ${claimed}`,
      )
      .bind(account, id, revision, description, status, priority, dueOn),
    insertTags(db, account, id, revision, ids),
    taskStatement(db, account, id),
  ]);
  const row = task!.results[0];
  return row ? decodeTask(row) : null;
};

export const updateTask = async (
  db: D1Database,
  account: string,
  id: string,
  input: typeof TaskUpdate.Type,
  now: number,
) => {
  const revision = crypto.randomUUID();
  const tagIds = JSON.stringify([...new Set(input.tagIds)]);
  const [item, , , , task] = await db.batch<TaskRow>([
    db
      .prepare(
        `UPDATE items SET title = ?4, revision = ?5, updated_at = ?6
         WHERE account_id = ?1 AND id = ?2 AND revision = ?3 AND kind = 'task'
         AND EXISTS (SELECT 1 FROM tasks WHERE account_id = ?1 AND item_id = ?2)
         AND ${tagsAreAvailable("?7")}`,
      )
      .bind(account, id, input.revision, input.title, revision, now, tagIds),
    db
      .prepare(
        `UPDATE tasks SET description = ?4, status = ?5, priority = ?6, due_on = ?7
         WHERE account_id = ?1 AND item_id = ?2 AND ${claimed}`,
      )
      .bind(
        account,
        id,
        revision,
        input.description,
        input.status,
        input.priority,
        input.dueOn,
      ),
    db
      .prepare(
        `DELETE FROM item_tags WHERE account_id = ?1 AND item_id = ?2 AND ${claimed}`,
      )
      .bind(account, id, revision),
    insertTags(db, account, id, revision, tagIds),
    taskStatement(db, account, id),
  ]);
  const row = task!.results[0];
  return {
    changed: item!.meta.changes > 0,
    task: row ? decodeTask(row) : null,
  };
};

export const createTag = async (
  db: D1Database,
  account: string,
  input: string,
) => {
  const name = normalizeTagName(input);
  if (!Schema.is(TagName)(name)) return null;
  const nameKey = name.toLowerCase();
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
