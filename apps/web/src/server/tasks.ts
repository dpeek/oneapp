import type { D1Database } from "@cloudflare/workers-types";
import { ByteSize, Clock, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  ItemId,
  normalizeTagName,
  TagCreate,
  TagName,
  tagsApi,
  type Tag,
} from "../items-contract.ts";
import {
  TaskCreate,
  tasksApi,
  TaskUpdate,
  type Task,
} from "../tasks-contract.ts";
import { jsonError, privateHeaders } from "./api-response.ts";
import { AppAuth, ownerId, type authHttp } from "./auth.ts";

type TaskRow = Omit<Task, "tagIds"> & { tagIds: string };
const taskProjection = `
  SELECT i.id, i.title, i.revision, i.created_at AS createdAt,
    i.updated_at AS updatedAt, t.description, t.status, t.priority, t.due_on AS dueOn,
    (
      SELECT json_group_array(tag_id)
      FROM item_tags WHERE account_id = i.account_id AND item_id = i.id
    ) AS tagIds
  FROM items i JOIN tasks t ON t.account_id = i.account_id AND t.item_id = i.id
  WHERE i.account_id = ?1 AND i.kind = 'task'`;

const readTask = (db: D1Database, account: string, id: string) =>
  db.prepare(`${taskProjection} AND i.id = ?2`).bind(account, id);

const decodeTask = (row: TaskRow): Task => ({
  ...row,
  tagIds: JSON.parse(row.tagIds),
});

const taskIndex = async (db: D1Database, account: string) => {
  const [taskRows, tagRows] = await db.batch<TaskRow | Tag>([
    db
      .prepare(`${taskProjection} ORDER BY i.updated_at DESC, i.id DESC`)
      .bind(account),
    db
      .prepare(
        "SELECT id, name FROM tags WHERE account_id = ? ORDER BY name_key",
      )
      .bind(account),
  ]);
  return {
    tasks: (taskRows!.results as TaskRow[]).map(decodeTask),
    tags: tagRows!.results as Tag[],
  };
};

const createTask = async (
  db: D1Database,
  account: string,
  { id, title }: typeof TaskCreate.Type,
  now: number,
) => {
  const [, , task] = await db.batch<TaskRow>([
    db
      .prepare(
        `INSERT INTO items (account_id, id, kind, title, revision, created_at, updated_at)
         VALUES (?1, ?2, 'task', ?3, ?4, ?5, ?5) ON CONFLICT DO NOTHING`,
      )
      .bind(account, id, title, crypto.randomUUID(), now),
    db
      .prepare(
        `INSERT INTO tasks (account_id, item_id)
         SELECT account_id, id FROM items WHERE account_id = ? AND id = ? AND kind = 'task'
         ON CONFLICT DO NOTHING`,
      )
      .bind(account, id),
    readTask(db, account, id),
  ]);
  const row = task!.results[0];
  return row ? decodeTask(row) : null;
};

const updateTask = async (
  db: D1Database,
  account: string,
  id: string,
  input: typeof TaskUpdate.Type,
  now: number,
) => {
  const revision = crypto.randomUUID();
  const tagIds = JSON.stringify([...new Set(input.tagIds)]);
  // The other writes run only if this batch claimed the item's revision.
  const claimed = `EXISTS (
    SELECT 1 FROM items WHERE account_id = ?1 AND id = ?2 AND revision = ?3
  )`;
  const [item, , , , task] = await db.batch<TaskRow>([
    db
      .prepare(
        `UPDATE items SET title = ?4, revision = ?5, updated_at = ?6
         WHERE account_id = ?1 AND id = ?2 AND revision = ?3 AND kind = 'task'
         AND EXISTS (SELECT 1 FROM tasks WHERE account_id = ?1 AND item_id = ?2)
         AND NOT EXISTS (
           SELECT 1 FROM json_each(?7) AS requested
           WHERE NOT EXISTS (SELECT 1 FROM tags WHERE account_id = ?1 AND id = requested.value)
         )`,
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
    db
      .prepare(
        `INSERT INTO item_tags (account_id, item_id, tag_id)
         SELECT ?1, ?2, value FROM json_each(?4) WHERE ${claimed}`,
      )
      .bind(account, id, revision, tagIds),
    readTask(db, account, id),
  ]);
  const row = task!.results[0];
  return {
    changed: item!.meta.changes > 0,
    task: row ? decodeTask(row) : null,
  };
};

const createTag = async (db: D1Database, account: string, name: string) => {
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

const json = (value: unknown, status = 200) =>
  HttpServerResponse.json(value, { status, headers: privateHeaders });
const readInput = <A>(schema: Schema.Decoder<A>) =>
  HttpServerRequest.schemaBodyJson(schema).pipe(
    Effect.provideService(
      HttpServerRequest.MaxBodySize,
      ByteSize.kibibytes(128),
    ),
    Effect.option,
  );

export const tasksRoutes = (
  http: ReturnType<typeof authHttp>,
  db: D1Database,
) => {
  const authenticated = <E, R>(
    handler: (
      account: string,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) =>
    Effect.gen(function* () {
      const auth = yield* AppAuth;
      const { subjectId } = yield* auth.requireSession;
      if (subjectId !== ownerId)
        return yield* jsonError(403, "Request not allowed");
      return yield* handler(subjectId);
    });
  const handle = <E, R>(
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) =>
    handler.pipe(
      Effect.catch((error) => {
        const tag =
          typeof error === "object" && error !== null && "_tag" in error
            ? error._tag
            : null;
        if (tag === "AuthenticationRequired")
          return jsonError(401, "Sign in required");
        if (tag === "HookDenied") return jsonError(403, "Request not allowed");
        return jsonError(503, "Tasks are unavailable. Try again.");
      }),
    );

  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      tasksApi,
      handle(
        authenticated((account) =>
          Effect.tryPromise(() => taskIndex(db, account)).pipe(
            Effect.flatMap(json),
          ),
        ),
      ),
    ),
    HttpRouter.add(
      "POST",
      tasksApi,
      handle(
        http.protect(
          authenticated((account) =>
            Effect.gen(function* () {
              const input = yield* readInput(TaskCreate);
              if (input._tag === "None")
                return yield* jsonError(400, "Enter a task title.");
              const now = yield* Clock.currentTimeMillis;
              const task = yield* Effect.tryPromise(() =>
                createTask(db, account, input.value, now),
              );
              return yield* task
                ? json(task, 201)
                : jsonError(409, "Could not create the task.");
            }),
          ),
        ),
      ),
    ),
    HttpRouter.add(
      "PUT",
      `${tasksApi}/:id`,
      handle(
        http.protect(
          authenticated((account) =>
            Effect.gen(function* () {
              const { id } = yield* HttpRouter.params;
              if (!Schema.is(ItemId)(id))
                return yield* jsonError(404, "Task not found.");
              const input = yield* readInput(TaskUpdate);
              if (input._tag === "None")
                return yield* jsonError(
                  400,
                  "Check the task title, due date and other fields.",
                );
              const now = yield* Clock.currentTimeMillis;
              const result = yield* Effect.tryPromise(() =>
                updateTask(db, account, id, input.value, now),
              );
              if (!result.task) return yield* jsonError(404, "Task not found.");
              if (result.changed) return yield* json(result.task);
              if (result.task.revision !== input.value.revision)
                return yield* json(result.task, 409);
              return yield* jsonError(400, "One or more tags are unavailable.");
            }),
          ),
        ),
      ),
    ),
    HttpRouter.add(
      "POST",
      tagsApi,
      handle(
        http.protect(
          authenticated((account) =>
            Effect.gen(function* () {
              const input = yield* readInput(TagCreate);
              const name =
                input._tag === "Some" ? normalizeTagName(input.value.name) : "";
              if (!Schema.is(TagName)(name))
                return yield* jsonError(400, "Enter a tag name.");
              const tag = yield* Effect.tryPromise(() =>
                createTag(db, account, name),
              );
              return yield* json(tag);
            }),
          ),
        ),
      ),
    ),
  );
};
