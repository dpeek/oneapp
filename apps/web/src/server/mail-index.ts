import type { D1Database, R2Bucket, R2Object } from "@cloudflare/workers-types";
import { Schema } from "effect";
import {
  InboxMessageId,
  MailPeople,
  type ConversationMessage,
  type MailFolder,
} from "../inbox-contract.ts";
import { mailPeople } from "./mail-people.ts";

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
  const {
    id,
    folder,
    from,
    to,
    subject,
    timestamp,
    messageIds,
    originalId,
    unread,
    people,
  } = mail;
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
      INSERT INTO mail_index_messages (id, thread_id, folder, sender, recipient, subject, timestamp, unread, people)
      VALUES (?1, (SELECT thread_id FROM mail_index_keys WHERE identity = ?2), ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT(id) DO UPDATE SET people = excluded.people
      WHERE mail_index_messages.people IS NULL AND mail_index_messages.deleted = 0
    `,
      )
      .bind(
        id,
        localIdentity(id),
        folder,
        from,
        to,
        subject,
        timestamp,
        folder === "inbox" && unread ? 1 : 0,
        people ? JSON.stringify(people) : null,
      ),
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
    ON CONFLICT(id) DO UPDATE SET sender = '', recipient = '', subject = '', timestamp = 0, deleted = 1, unread = 0, people = NULL
  `,
    )
    .bind(id, folder)
    .run();
};

const isInboxId = Schema.is(InboxMessageId);
const pageSize = 20;
const scanSize = 12;

export const inboxUnread = async (db: D1Database) => {
  const row = await db
    .prepare(
      `
    SELECT count(*) AS unreadCount FROM mail_index_messages
    WHERE folder = 'inbox' AND deleted = 0 AND unread = 1
  `,
    )
    .first<{ unreadCount: number }>();
  return { unreadCount: row?.unreadCount ?? 0 };
};

export const inboxMessageUnread = async (db: D1Database, id: string) => {
  const row = await db
    .prepare(
      `
    SELECT unread FROM mail_index_messages
    WHERE id = ? AND folder = 'inbox' AND deleted = 0
  `,
    )
    .bind(id)
    .first<{ unread: number }>();
  return row ? row.unread === 1 : null;
};

export const setInboxUnread = async (
  db: D1Database,
  id: string,
  unread: boolean,
) => {
  const updated = await db
    .prepare(
      `
    UPDATE mail_index_messages SET unread = ?2
    WHERE id = ?1 AND folder = 'inbox' AND deleted = 0 AND unread <> ?2
    RETURNING id
  `,
    )
    .bind(id, unread ? 1 : 0)
    .first<{ id: string }>();
  if (updated) return "changed";
  return (await inboxMessageUnread(db, id)) === null ? "missing" : "unchanged";
};

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
            WHERE member.thread_id = m.thread_id AND member.deleted = 0) AS messageCount,
           (SELECT count(*) FROM mail_index_messages member
            WHERE member.thread_id = m.thread_id AND member.folder = 'inbox'
              AND member.deleted = 0 AND member.unread = 1) AS unreadCount
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
      unreadCount: number;
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

const decodePeople = Schema.decodeUnknownOption(
  Schema.fromJsonString(MailPeople),
);

export const readThread = async (db: D1Database, id: string) => {
  const { results } = await db
    .prepare(
      `
    SELECT id, folder, sender AS "from", recipient AS "to", subject, timestamp, unread, people
    FROM mail_index_messages
    WHERE thread_id = (SELECT thread_id FROM mail_index_keys WHERE identity = ?)
      AND deleted = 0
    ORDER BY timestamp, id
  `,
    )
    .bind(localIdentity(id))
    .all<
      Omit<ConversationMessage, "unread" | "people"> & {
        unread: number;
        people: string | null;
      }
    >();
  return {
    messages: results.map(({ unread, people, ...message }) => {
      const decoded = decodePeople(people);
      return {
        ...message,
        unread: unread === 1,
        people:
          decoded._tag === "Some"
            ? decoded.value
            : mailPeople(() => undefined, message.from, message.to),
      };
    }),
  };
};

export const scanMail = async (
  db: D1Database,
  folder: MailFolder,
  bucket: R2Bucket,
  describe: (object: R2Object) => Promise<IndexedMail | null>,
  reconcile: boolean,
) => {
  // This scan also enriches rows created before message participants were indexed.
  const scanId = `${folder}:people`;
  const state = await db
    .prepare(
      "SELECT cursor, scanned_at AS scannedAt, ready FROM mail_index_scans WHERE folder = ?",
    )
    .bind(scanId)
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
        "SELECT id FROM mail_index_messages WHERE (deleted = 1 OR people IS NOT NULL) AND id IN (SELECT value FROM json_each(?))",
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
      scanId,
      page.truncated ? page.cursor : null,
      Date.now(),
      state?.ready || !page.truncated ? 1 : 0,
      state?.cursor ?? null,
      state?.scannedAt ?? -1,
    )
    .run();
  return page.truncated && !state?.ready;
};
