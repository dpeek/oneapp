import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  type TaskAttachment,
  taskAttachmentObjectKey,
} from "../task-attachment-contract.ts";

const columns =
  "id, name, media_type AS mediaType, size, created_at AS createdAt";
const pendingLifetime = 60 * 60_000;

export const listTaskAttachments = async (
  db: D1Database,
  account: string,
  taskId: string,
) => {
  const { results } = await db
    .prepare(
      `SELECT ${columns} FROM task_attachments
       WHERE account_id = ? AND task_id = ? AND state = 'ready'
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
       WHERE account_id = ? AND task_id = ? AND id = ? AND state = 'ready'`,
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
) => {
  const id = crypto.randomUUID();
  const size = bytes.byteLength;
  const reserved = await db
    .prepare(
      `INSERT INTO task_attachments
        (account_id, task_id, id, name, media_type, size, created_at, state)
       SELECT account_id, item_id, ?, ?, ?, ?, ?, 'pending'
       FROM tasks WHERE account_id = ? AND item_id = ?
       RETURNING id`,
    )
    .bind(id, metadata.name, metadata.mediaType, size, now, account, taskId)
    .first<{ id: string }>();
  if (!reserved) return null;

  const key = taskAttachmentObjectKey(account, taskId, id);
  // Abandoned reservations give the collector an object key even when a put
  // succeeds but its response is lost. Only ready rows grant access.
  const stored = await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: metadata.mediaType },
  });
  if (!stored) throw new Error("Could not reserve the attachment object.");
  try {
    const saved = await db
      .prepare(
        `UPDATE task_attachments SET state = 'ready'
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
  await bucket.delete(key);
  return null;
};

export const removeTaskAttachment = (
  db: D1Database,
  account: string,
  taskId: string,
  id: string,
) =>
  db
    .prepare(
      `UPDATE task_attachments SET state = 'removed'
       WHERE account_id = ? AND task_id = ? AND id = ? AND state IN ('ready', 'removed')
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

export const collectTaskAttachments = async (
  db: D1Database,
  bucket: R2Bucket,
  now = Date.now(),
) => {
  const { results } = await db
    .prepare(
      `UPDATE task_attachments SET state = 'removed'
       WHERE (account_id, task_id, id) IN (
         SELECT account_id, task_id, id FROM task_attachments
         WHERE state = 'removed' OR (state = 'pending' AND created_at <= ?)
         ORDER BY created_at, id LIMIT 100
       )
       RETURNING account_id AS account, task_id AS taskId, id`,
    )
    .bind(now - pendingLifetime)
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
