import type { D1Database, R2Bucket, R2Object } from "@cloudflare/workers-types";
import { Schema } from "effect";
import {
  InboxMessageId,
  type ConversationMessage,
  type MailFolder,
} from "../inbox-contract.ts";

export type IndexedMail = ConversationMessage & {
  messageIds: readonly string[];
  originalId?: string;
};

const localIdentity = (id: string) => `mail:${id}`;
const hashMessageId = async (id: string) => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(id),
  );
  return `rfc:${new Uint8Array(bytes).toHex()}`;
};

const matchingThreads = `SELECT thread_id FROM mail_index_keys WHERE identity IN (SELECT value FROM json_each(?1))`;
const canonicalThread = `SELECT min(thread_id) FROM (${matchingThreads})`;
const threadsToMerge = `WITH matched AS MATERIALIZED (${matchingThreads}),
  target AS (SELECT min(thread_id) FROM matched)`;

const indexStatements = async (db: D1Database, mail: IndexedMail) => {
  const { id, folder, from, to, subject, timestamp, messageIds, originalId } =
    mail;
  const aliases = JSON.stringify([
    localIdentity(id),
    ...(originalId ? [localIdentity(originalId)] : []),
    ...(await Promise.all(messageIds.map(hashMessageId))),
  ]);
  // D1 batches run atomically. Move both memberships and aliases when a
  // message connects conversations that were previously indexed separately.
  return [
    db
      .prepare(
        `
      INSERT OR IGNORE INTO mail_index_keys (identity, thread_id)
      SELECT value, coalesce((${canonicalThread}), ?2) FROM json_each(?1)
    `,
      )
      .bind(aliases, id),
    db
      .prepare(
        `
      ${threadsToMerge}
      UPDATE mail_index_messages SET thread_id = (SELECT * FROM target)
      WHERE thread_id IN matched AND thread_id <> (SELECT * FROM target)
    `,
      )
      .bind(aliases),
    db
      .prepare(
        `
      ${threadsToMerge}
      UPDATE mail_index_keys SET thread_id = (SELECT * FROM target)
      WHERE thread_id IN matched AND thread_id <> (SELECT * FROM target)
    `,
      )
      .bind(aliases),
    db
      .prepare(
        `
      INSERT OR IGNORE INTO mail_index_messages (id, thread_id, folder, sender, recipient, subject, timestamp)
      VALUES (?1, (SELECT thread_id FROM mail_index_keys WHERE identity = ?2), ?3, ?4, ?5, ?6, ?7)
    `,
      )
      .bind(id, localIdentity(id), folder, from, to, subject, timestamp),
  ];
};

export const indexMail = async (db: D1Database, mail: IndexedMail) => {
  await db.batch(await indexStatements(db, mail));
};

export const removeIndexedMail = async (
  db: D1Database,
  folder: MailFolder,
  id: string,
) => {
  // Retain the opaque ID to prevent an in-flight R2 scan from recreating this row.
  await db
    .prepare(
      `
    INSERT INTO mail_index_messages (id, thread_id, folder, sender, recipient, subject, timestamp, deleted)
    VALUES (?1, ?1, ?2, '', '', '', 0, 1)
    ON CONFLICT(id) DO UPDATE SET sender = '', recipient = '', subject = '', timestamp = 0, deleted = 1
  `,
    )
    .bind(id, folder)
    .run();
};

const isInboxId = Schema.is(InboxMessageId);
const pageSize = 20;
const scanSize = 12;

export const inboxThreadCursor = (cursor: string | undefined) => {
  if (cursor === undefined) return { timestamp: null, id: "" };
  const [time, id, extra] = cursor.split("/");
  const timestamp = Number(time);
  return extra === undefined &&
    isInboxId(id) &&
    /^\d+$/u.test(time ?? "") &&
    Number.isSafeInteger(timestamp)
    ? { timestamp, id }
    : null;
};

export const listInboxThreads = async (
  db: D1Database,
  cursor: NonNullable<ReturnType<typeof inboxThreadCursor>>,
) => {
  const { results } = await db
    .prepare(
      `
    SELECT m.id, m.sender AS "from", m.subject, m.timestamp AS receivedAt,
           (SELECT count(*) FROM mail_index_messages member
            WHERE member.thread_id = m.thread_id AND member.deleted = 0) AS messageCount
    FROM mail_index_messages m
    WHERE m.folder = 'inbox' AND m.deleted = 0
      AND (?1 IS NULL OR (m.timestamp, m.id) < (?1, ?2))
      AND NOT EXISTS (
        SELECT 1 FROM mail_index_messages newer
        WHERE newer.thread_id = m.thread_id AND newer.folder = 'inbox' AND newer.deleted = 0
          AND (newer.timestamp, newer.id) > (m.timestamp, m.id)
      )
    ORDER BY m.timestamp DESC, m.id DESC LIMIT ?3
  `,
    )
    .bind(cursor.timestamp, cursor.id, pageSize + 1)
    .all<{
      id: string;
      from: string;
      subject: string;
      receivedAt: number;
      messageCount: number;
    }>();
  const messages = results.slice(0, pageSize);
  const last = messages.at(-1);
  return {
    messages,
    cursor:
      last && results.length > pageSize
        ? `${last.receivedAt}/${last.id}`
        : null,
  };
};

export const readThread = async (db: D1Database, id: string) => {
  const { results } = await db
    .prepare(
      `
    SELECT id, folder, sender AS "from", recipient AS "to", subject, timestamp
    FROM mail_index_messages
    WHERE thread_id = (SELECT thread_id FROM mail_index_keys WHERE identity = ?)
      AND deleted = 0
    ORDER BY timestamp, id
  `,
    )
    .bind(localIdentity(id))
    .all<ConversationMessage>();
  return { messages: results };
};

export const scanMail = async (
  db: D1Database,
  folder: MailFolder,
  bucket: R2Bucket,
  describe: (object: R2Object) => Promise<IndexedMail | null>,
  reconcile: boolean,
) => {
  const state = await db
    .prepare(
      "SELECT cursor, scanned_at AS scannedAt, ready FROM mail_index_scans WHERE folder = ?",
    )
    .bind(folder)
    .first<{ cursor: string | null; scannedAt: number; ready: number }>();
  if (state?.ready && !reconcile) return false;
  const page = await bucket.list({
    limit: scanSize,
    cursor: state?.cursor ?? undefined,
    include: ["customMetadata"],
  });
  if (page.objects.length) {
    const { results } = await db
      .prepare(
        "SELECT id FROM mail_index_messages WHERE id IN (SELECT value FROM json_each(?))",
      )
      .bind(JSON.stringify(page.objects.map(({ key }) => key)))
      .all<{ id: string }>();
    const known = new Set(results.map(({ id }) => id));
    const missing = page.objects.filter(({ key }) => !known.has(key));
    const indexed: IndexedMail[] = [];
    for (let offset = 0; offset < missing.length; offset += 4) {
      const messages = await Promise.all(
        missing.slice(offset, offset + 4).map(describe),
      );
      for (const message of messages) if (message) indexed.push(message);
    }
    if (indexed.length)
      await db.batch(
        (
          await Promise.all(indexed.map((mail) => indexStatements(db, mail)))
        ).flat(),
      );
  }
  await db
    .prepare(
      `
    INSERT INTO mail_index_scans (folder, cursor, scanned_at, ready) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(folder) DO UPDATE SET cursor = excluded.cursor, scanned_at = excluded.scanned_at, ready = excluded.ready
    WHERE mail_index_scans.cursor IS ?5 AND mail_index_scans.scanned_at = ?6
  `,
    )
    .bind(
      folder,
      page.truncated ? page.cursor : null,
      Date.now(),
      state?.ready || !page.truncated ? 1 : 0,
      state?.cursor ?? null,
      state?.scannedAt ?? -1,
    )
    .run();
  return page.truncated && !state?.ready;
};
