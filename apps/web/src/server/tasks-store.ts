import type { D1Database } from "@cloudflare/workers-types";
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
import {
  defaultTaskStatus,
  type Task,
  type TaskCreate,
  type TaskUpdate,
  type WorkspaceActor,
} from "../tasks-contract.ts";

type TaskSummary = Omit<Task, "description">;
type TaskRow<T extends TaskSummary = Task> = Omit<T, "tagIds" | "latestRun"> & {
  tagIds: string;
  latestRun: string | null;
};
const taskColumns = `
  i.id, i.title, i.revision, i.created_at AS createdAt,
    i.updated_at AS updatedAt, t.status, t.priority, t.due_on AS dueOn,
    t.author, t.assignee,
    CASE WHEN r.id IS NOT NULL THEN json_object(
      'id', r.id, 'phase', r.phase, 'startedAt', r.started_at,
      'updatedAt', r.updated_at, 'expiresAt', r.expires_at,
      'finishedAt', r.finished_at, 'outcome', r.outcome, 'summary', r.summary,
      'reason', r.reason, 'deploymentUrl', r.deployment_url
    ) END AS latestRun,
    ${itemTagIdsColumn}`;
const taskSource = `
  FROM items i JOIN tasks t ON t.account_id = i.account_id AND t.item_id = i.id
  LEFT JOIN task_runs r ON r.account_id = i.account_id AND r.task_id = i.id
  WHERE i.account_id = ?1 AND i.kind = 'task'`;
const taskProjection = `SELECT ${taskColumns}, t.description ${taskSource}`;
const taskOrder = "ORDER BY i.updated_at DESC, i.id DESC";

const taskStatement = (db: D1Database, account: string, id: string) =>
  db.prepare(`${taskProjection} AND i.id = ?2`).bind(account, id);

const versionStatement = (db: D1Database, account: string) =>
  itemVersionStatement(db, "task", account);

export const incrementTaskVersion = (db: D1Database, condition: string) =>
  incrementItemVersion(db, "task", condition);

const recordTaskChange = (
  db: D1Database,
  account: string,
  id: string,
  revision: string,
) => incrementTaskVersion(db, claimed).bind(account, id, revision);

const decodeTask = <T extends TaskRow<TaskSummary>>({
  tagIds,
  latestRun,
  ...fields
}: T) => ({
  ...fields,
  tagIds: JSON.parse(tagIds) as readonly string[],
  latestRun:
    latestRun === null ? null : (JSON.parse(latestRun) as Task["latestRun"]),
});

export const getTask = async (db: D1Database, account: string, id: string) => {
  const task = await taskStatement(db, account, id).first<TaskRow>();
  return task ? decodeTask(task) : null;
};

export const taskVersion = async (db: D1Database, account: string) =>
  (await versionStatement(db, account).first<number>("version")) ?? 0;

export const taskIndex = async (
  db: D1Database,
  account: string,
  assignee?: Task["assignee"],
) => {
  const filter = assignee === undefined ? "" : "AND t.assignee IS ?2";
  const [taskRows, tagRows, versionRows] = await db.batch<
    TaskRow | Tag | { version: number }
  >([
    db
      .prepare(`${taskProjection} ${filter} ${taskOrder}`)
      .bind(...(assignee === undefined ? [account] : [account, assignee])),
    tagCatalog(db, account),
    versionStatement(db, account),
  ]);
  return {
    tasks: (taskRows!.results as TaskRow[]).map(decodeTask),
    tags: tagRows!.results as Tag[],
    version:
      (versionRows!.results[0] as { version: number } | undefined)?.version ??
      0,
  };
};

type TaskFilters = {
  query?: string | undefined;
  status?: "active" | "all" | Task["status"] | undefined;
  priority?: Task["priority"] | undefined;
  assignee?: Task["assignee"] | undefined;
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
    assignee,
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
    filters.push("t.status NOT IN ('completed', 'canceled')");
  else if (status !== "all") filter("t.status = ?", status);
  if (priority !== undefined) filter("t.priority IS ?", priority);
  if (assignee !== undefined) filter("t.assignee IS ?", assignee);
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

export const createTask = async (
  db: D1Database,
  { accountId: account, kind: author }: WorkspaceActor,
  {
    id,
    title,
    description = "",
    status = defaultTaskStatus,
    priority = null,
    dueOn = null,
    tagIds = [],
    assignee = author,
  }: typeof TaskCreate.Type,
  now: number,
) => {
  const revision = crypto.randomUUID();
  const ids = JSON.stringify([...new Set(tagIds)]);
  const [, , , , task] = await db.batch<TaskRow>([
    db
      .prepare(
        `INSERT INTO items (account_id, id, kind, title, revision, created_at, updated_at)
         SELECT ?1, ?2, 'task', ?3, ?4, ?5, ?5 WHERE ${tagsAreAvailable("?6")}
         ON CONFLICT DO NOTHING`,
      )
      .bind(account, id, title, revision, now, ids),
    db
      .prepare(
        `INSERT INTO tasks (account_id, item_id, description, status, priority, due_on, author, assignee)
         SELECT ?1, ?2, ?4, ?5, ?6, ?7, ?8, ?9 WHERE ${claimed}`,
      )
      .bind(
        account,
        id,
        revision,
        description,
        status,
        priority,
        dueOn,
        author,
        assignee,
      ),
    insertTags(db, account, id, revision, ids),
    recordTaskChange(db, account, id, revision),
    taskStatement(db, account, id),
  ]);
  const row = task!.results[0];
  return {
    changed: row?.revision === revision,
    task: row ? decodeTask(row) : null,
  };
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
  const [item, , , , , task] = await db.batch<TaskRow>([
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
        `UPDATE tasks SET description = ?4, status = ?5, priority = ?6, due_on = ?7,
           assignee = CASE WHEN ?8 THEN ?9 ELSE assignee END
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
        input.assignee !== undefined ? 1 : 0,
        input.assignee ?? null,
      ),
    deleteTags(db, account, id, revision),
    insertTags(db, account, id, revision, tagIds),
    recordTaskChange(db, account, id, revision),
    taskStatement(db, account, id),
  ]);
  const row = task!.results[0];
  return {
    changed: item!.meta.changes > 0,
    task: row ? decodeTask(row) : null,
  };
};

export const deleteTask = async (
  db: D1Database,
  account: string,
  id: string,
  revision: string,
) => {
  const [deleted, , remaining] = await db.batch<{ id: string }>([
    db
      .prepare(
        `DELETE FROM items
         WHERE account_id = ?1 AND id = ?2 AND revision = ?3 AND kind = 'task'
           AND EXISTS (SELECT 1 FROM tasks WHERE account_id = ?1 AND item_id = ?2)
         RETURNING id`,
      )
      .bind(account, id, revision),
    incrementTaskVersion(db, "changes() = 1").bind(account),
    db.prepare(`SELECT i.id ${taskSource} AND i.id = ?2`).bind(account, id),
  ]);
  return deleted!.results.length
    ? "deleted"
    : remaining!.results.length
      ? "conflict"
      : "missing";
};
