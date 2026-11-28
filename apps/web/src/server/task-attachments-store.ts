import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  type TaskAttachment,
  taskAttachmentObjectKey,
} from "../task-attachment-contract.ts";
import { claimed } from "./items-store.ts";

const columns =
  "id, name, media_type AS mediaType, size, created_at AS createdAt";
const pendingLifetime = 60 * 60_000;
const imageUndoWindow = 60 * 60_000;

export const listTaskAttachments = async (
  db: D1Database,
  account: string,
  taskId: string,
) => {
  const { results } = await db
    .prepare(
      `SELECT ${columns} FROM task_attachments
       WHERE account_id = ? AND task_id = ? AND state = 'ready'
         AND inline_delete_after IS NULL
       ORDER BY created_at, id`,
    )
    .bind(account, taskId)
    .all<TaskAttachment>();
  return results;
};

const getAttachment = (
  db: D1Database,
  account: string,
  taskId: string,
  id: string,
) =>
  db
    .prepare(
      `SELECT ${columns} FROM task_attachments
       WHERE account_id = ? AND task_id = ? AND id = ?
         AND (state = 'staged' OR (state = 'ready' AND inline_delete_after IS NULL))`,
    )
    .bind(account, taskId, id)
    .first<TaskAttachment>();

export const readTaskAttachment = async (
  db: D1Database,
  bucket: R2Bucket,
  account: string,
  taskId: string,
  id: string,
) => {
  const attachment = await getAttachment(db, account, taskId, id);
  if (!attachment) return null;
  const object = await bucket.get(taskAttachmentObjectKey(account, taskId, id));
  if (!object) return null;
  return { attachment, object };
};

export const createTaskAttachment = async (
  db: D1Database,
  bucket: R2Bucket,
  account: string,
  taskId: string,
  metadata: Pick<TaskAttachment, "name" | "mediaType">,
  bytes: ArrayBuffer,
  now: number,
  id: string = crypto.randomUUID(),
  inline = false,
) => {
  const size = bytes.byteLength;
  const reserved = await db
    .prepare(
      `INSERT INTO task_attachments
        (account_id, task_id, id, name, media_type, size, created_at, state, inline_delete_after)
       SELECT account_id, item_id, ?, ?, ?, ?, ?, 'pending', ?
       FROM tasks WHERE account_id = ? AND item_id = ?
       ON CONFLICT DO NOTHING
       RETURNING id`,
    )
    .bind(
      id,
      metadata.name,
      metadata.mediaType,
      size,
      now,
      inline ? now + pendingLifetime : null,
      account,
      taskId,
    )
    .first<{ id: string }>();
  if (!reserved) {
    const existing = await db
      .prepare(
        `SELECT ${columns}, state FROM task_attachments
         WHERE account_id = ? AND task_id = ? AND id = ?`,
      )
      .bind(account, taskId, id)
      .first<TaskAttachment & { state: string }>();
    if (!existing || existing.state === "removed") return null;
    if (
      existing.name !== metadata.name ||
      existing.mediaType !== metadata.mediaType ||
      existing.size !== size
    )
      throw new Error("Screenshot ID already in use.");
    if (existing.state === "ready" || existing.state === "staged")
      return getAttachment(db, account, taskId, id);
  }

  const key = taskAttachmentObjectKey(account, taskId, id);
  // Abandoned reservations give the collector an object key even when a put
  // succeeds but its response is lost. The conditional put lets a retry
  // finalize the existing object without overwriting it.
  await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: metadata.mediaType },
  });
  try {
    const saved = await db
      .prepare(
        `UPDATE task_attachments
         SET state = CASE WHEN inline_delete_after IS NULL THEN 'ready' ELSE 'staged' END
         WHERE account_id = ? AND task_id = ? AND id = ? AND state = 'pending'
         RETURNING ${columns}`,
      )
      .bind(account, taskId, id)
      .first<TaskAttachment>();
    if (saved) return saved;
  } catch (error) {
    const saved = await getAttachment(db, account, taskId, id);
    if (saved) return saved;
    throw error;
  }
  return getAttachment(db, account, taskId, id);
};

// Claim these changes in the same batch as the description write. An unsaved
// or conflicting deletion must leave the attachment available.
export const reconcileTaskImages = (
  db: D1Database,
  account: string,
  taskId: string,
  revision: string,
  linked: ReadonlySet<string>,
  unlinked: readonly string[],
  now: number,
) => [
  ...(linked.size
    ? [
        db
          .prepare(
            `UPDATE task_attachments SET state = 'ready', inline_delete_after = NULL
     WHERE account_id = ?1 AND task_id = ?2 AND ${claimed}
       AND state IN ('ready', 'staged') AND inline_delete_after IS NOT NULL
       AND id IN (SELECT value FROM json_each(?4))`,
          )
          .bind(account, taskId, revision, JSON.stringify([...linked])),
      ]
    : []),
  ...(unlinked.length
    ? [
        db
          .prepare(
            `UPDATE task_attachments SET inline_delete_after = ?5
     WHERE account_id = ?1 AND task_id = ?2 AND ${claimed} AND state = 'ready'
       AND id IN (SELECT value FROM json_each(?4))`,
          )
          .bind(
            account,
            taskId,
            revision,
            JSON.stringify(unlinked),
            now + imageUndoWindow,
          ),
      ]
    : []),
];

export const removeTaskAttachment = (
  db: D1Database,
  account: string,
  taskId: string,
  id: string,
) =>
  db
    .prepare(
      `UPDATE task_attachments SET state = 'removed'
       WHERE account_id = ? AND task_id = ? AND id = ? AND state IN ('ready', 'staged', 'removed')
       RETURNING id`,
    )
    .bind(account, taskId, id)
    .first<{ id: string }>();

const deleteRemoved = (
  db: D1Database,
  account: string,
  taskId: string,
  id: string,
) =>
  db
    .prepare(
      `DELETE FROM task_attachments
       WHERE account_id = ? AND task_id = ? AND id = ? AND state = 'removed'`,
    )
    .bind(account, taskId, id);

export const purgeTaskAttachment = async (
  db: D1Database,
  bucket: R2Bucket,
  account: string,
  taskId: string,
  id: string,
) => {
  await bucket.delete(taskAttachmentObjectKey(account, taskId, id));
  await deleteRemoved(db, account, taskId, id).run();
};

const collectRemovedAttachments = async (
  db: D1Database,
  bucket: R2Bucket,
  now: number,
) => {
  const { results } = await db
    .prepare(
      `UPDATE task_attachments SET state = 'removed'
       WHERE (account_id, task_id, id) IN (
         SELECT account_id, task_id, id FROM task_attachments
         WHERE state = 'removed' OR (state = 'pending' AND created_at <= ?)
            OR (state IN ('ready', 'staged') AND inline_delete_after <= ?)
         ORDER BY created_at, id LIMIT 100
       )
       RETURNING account_id AS account, task_id AS taskId, id`,
    )
    .bind(now - pendingLifetime, now)
    .all<{ account: string; taskId: string; id: string }>();
  if (!results.length) return;
  await bucket.delete(
    results.map(({ account, taskId, id }) =>
      taskAttachmentObjectKey(account, taskId, id),
    ),
  );
  await db.batch(
    results.map(({ account, taskId, id }) =>
      deleteRemoved(db, account, taskId, id),
    ),
  );
};

const collectDeletedTaskAttachments = async (
  db: D1Database,
  bucket: R2Bucket,
  now: number,
) => {
  const { results } = await db
    .prepare(
      `SELECT account_id AS account, task_id AS taskId, id
       FROM deleted_task_attachments WHERE delete_after <= ?
       ORDER BY delete_after LIMIT 100`,
    )
    .bind(now)
    .all<{ account: string; taskId: string; id: string }>();
  if (!results.length) return;
  await bucket.delete(
    results.map(({ account, taskId, id }) =>
      taskAttachmentObjectKey(account, taskId, id),
    ),
  );
  await db.batch(
    results.map(({ account, taskId, id }) =>
      db
        .prepare(
          `DELETE FROM deleted_task_attachments
           WHERE account_id = ? AND task_id = ? AND id = ?`,
        )
        .bind(account, taskId, id),
    ),
  );
};

export const collectTaskAttachments = (
  db: D1Database,
  bucket: R2Bucket,
  now = Date.now(),
) =>
  Promise.all([
    collectRemovedAttachments(db, bucket, now),
    collectDeletedTaskAttachments(db, bucket, now),
  ]);
