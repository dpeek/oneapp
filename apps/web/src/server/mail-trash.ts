import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { removeIndexedMail } from "./mail-index.ts";
import type { DeletedMailCursor, MailFolder } from "../inbox-contract.ts";

export const mailRetentionMs = 30 * 24 * 60 * 60 * 1000;
type Store = {
  DB: D1Database;
  INBOX_MESSAGES: R2Bucket;
  SENT_MESSAGES: R2Bucket;
};

export const hiddenMail = async (db: D1Database, id: string) =>
  Boolean(
    await db
      .prepare(
        "SELECT id FROM mail_index_messages WHERE id = ? AND deleted <> 0",
      )
      .bind(id)
      .first(),
  );

export const recoverableMail = async (db: D1Database, id: string) =>
  Boolean(
    await db
      .prepare(
        "SELECT id FROM mail_index_messages WHERE id = ? AND deleted = 1 AND deleted_at > ?",
      )
      .bind(id, Date.now() - mailRetentionMs)
      .first(),
  );

export const visibleMail = async <T extends { id: string }>(
  db: D1Database,
  messages: readonly T[],
) => {
  if (!messages.length) return [];
  const { results } = await db
    .prepare(
      "SELECT id FROM mail_index_messages WHERE deleted <> 0 AND id IN (SELECT value FROM json_each(?))",
    )
    .bind(JSON.stringify(messages.map(({ id }) => id)))
    .all<{ id: string }>();
  const hidden = new Set(results.map(({ id }) => id));
  return messages.filter(({ id }) => !hidden.has(id));
};

export const trashMail = (db: D1Database, id: string, now = Date.now()) =>
  db
    .prepare(
      "UPDATE mail_index_messages SET deleted = 1, deleted_at = ? WHERE id = ? AND deleted = 0",
    )
    .bind(now, id)
    .run();

export const restoreMail = async (
  db: D1Database,
  id: string,
  now = Date.now(),
) => {
  const result = await db
    .prepare(
      "UPDATE mail_index_messages SET deleted = 0, deleted_at = NULL WHERE id = ? AND deleted = 1 AND deleted_at > ? RETURNING id",
    )
    .bind(id, now - mailRetentionMs)
    .first();
  return Boolean(result);
};

export const listTrash = async (
  db: D1Database,
  cursor?: typeof DeletedMailCursor.Type,
) => {
  const { results } = await db
    .prepare(
      `SELECT id, folder, sender AS "from", subject, deleted_at AS deletedAt FROM mail_index_messages
    WHERE deleted = 1 AND deleted_at > ? AND (deleted_at, id) < (?, ?)
    ORDER BY deleted_at DESC, id DESC LIMIT 101`,
    )
    .bind(
      Date.now() - mailRetentionMs,
      cursor?.deletedAt ?? Date.now() + 1,
      cursor?.id ?? "",
    )
    .all<{
      id: string;
      folder: MailFolder;
      from: string;
      subject: string;
      deletedAt: number;
    }>();
  const messages = results.slice(0, 100);
  const last = messages.at(-1);
  return {
    messages,
    cursor:
      results.length > 100 && last
        ? JSON.stringify({ id: last.id, deletedAt: last.deletedAt })
        : null,
  };
};

export const collectMailTrash = async (env: Store, now = Date.now()) => {
  // Claim expired rows atomically. Restore cannot race an R2 deletion; failed
  // object deletions retain their claim and are retried on the next cron run.
  const { results } = await env.DB.prepare(
    `UPDATE mail_index_messages SET deleted = 2
    WHERE id IN (SELECT id FROM mail_index_messages WHERE
      (deleted = 1 AND deleted_at <= ?) OR deleted = 2 LIMIT 100)
    RETURNING id, folder`,
  )
    .bind(now - mailRetentionMs)
    .all<{ id: string; folder: MailFolder }>();
  let failures = 0;
  for (const { id, folder } of results) {
    try {
      await (folder === "sent" ? env.SENT_MESSAGES : env.INBOX_MESSAGES).delete(
        id,
      );
      await removeIndexedMail(env.DB, folder, id);
    } catch {
      failures++;
    }
  }
  if (failures)
    throw new Error(
      `Could not permanently delete ${failures} expired messages; cleanup will retry.`,
    );
};
