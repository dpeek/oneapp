import { mailboxSql, type MailDatabase } from "./mailbox.ts";

const retained = "(deleted = 0 OR deleted_at IS NOT NULL)";

const conversationsForMessages = (mailbox: string) => `
  SELECT DISTINCT thread_id FROM mail_index_messages
  WHERE mailbox_id = ${mailbox} AND id IN (SELECT value FROM json_each(?1))`;

// Use retained messages so a trip through Trash preserves the item and its
// tags. Visibility is determined by the mail view. Purging a message removes
// it from these aggregates, and purging the last message removes the item.
const refreshItem = (
  db: MailDatabase,
  messageIds: string,
  newId: string | null,
) => {
  const mailbox = mailboxSql(db);
  return db
    .prepare(
      `WITH conversations AS (${conversationsForMessages(mailbox)}),
      members AS MATERIALIZED (
        SELECT thread_id, id, subject, timestamp FROM mail_index_messages
        WHERE mailbox_id = ${mailbox} AND thread_id IN conversations
          AND ${retained}
      ), metadata AS (
        SELECT thread_id, coalesce((
          SELECT trim(subject) FROM members
          WHERE thread_id = thread.thread_id AND trim(subject) <> ''
          ORDER BY timestamp, id LIMIT 1
        ), '(No subject)') AS title,
          min(timestamp) AS created_at, max(timestamp) AS updated_at
        FROM members AS thread GROUP BY thread_id
      )
      INSERT INTO items (account_id, id, kind, title, revision, created_at, updated_at)
      SELECT b.owner_account_id, coalesce(c.item_id, ?2), 'mail-conversation', m.title, ?3, m.created_at, m.updated_at
      FROM mailboxes b CROSS JOIN metadata m
      LEFT JOIN mail_conversations c ON c.mailbox_id = b.id AND c.thread_id = m.thread_id
      WHERE b.id = ${mailbox} AND (c.item_id IS NOT NULL OR ?2 IS NOT NULL)
      ON CONFLICT (account_id, id) DO UPDATE SET
        title = excluded.title, revision = excluded.revision,
        created_at = excluded.created_at, updated_at = excluded.updated_at
      WHERE items.title <> excluded.title OR items.created_at <> excluded.created_at
        OR items.updated_at <> excluded.updated_at`,
    )
    .bind(messageIds, newId, crypto.randomUUID());
};

export const indexConversationItem = (db: MailDatabase, messageId: string) => {
  const mailbox = mailboxSql(db);
  const itemId = crypto.randomUUID();
  return [
    refreshItem(db, JSON.stringify([messageId]), itemId),
    db
      .prepare(
        `INSERT INTO mail_conversations (mailbox_id, thread_id, account_id, item_id)
        SELECT b.id, (SELECT thread_id FROM mail_index_messages WHERE mailbox_id = b.id AND id = ?1), b.owner_account_id, i.id
        FROM mailboxes b JOIN items i ON i.account_id = b.owner_account_id AND i.id = ?2
        WHERE b.id = ${mailbox}`,
      )
      .bind(messageId, itemId),
  ];
};

export const removeConversationItems = (
  db: MailDatabase,
  messageIds: string,
) => {
  const mailbox = mailboxSql(db);
  return [
    refreshItem(db, messageIds, null),
    db
      .prepare(
        `WITH conversations AS (${conversationsForMessages(mailbox)})
        DELETE FROM items WHERE (account_id, id) IN (
          SELECT c.account_id, c.item_id FROM mail_conversations c
          WHERE c.mailbox_id = ${mailbox} AND c.thread_id IN conversations
            AND NOT EXISTS (
              SELECT 1 FROM mail_index_messages
              WHERE mailbox_id = c.mailbox_id AND thread_id = c.thread_id AND ${retained}
            )
        )`,
      )
      .bind(messageIds),
  ];
};

export const mergeConversationItems = (
  db: MailDatabase,
  merge: string,
  aliases: string,
) => {
  const mailbox = mailboxSql(db);
  const losing = `mailbox_id = ${mailbox} AND thread_id IN matched AND thread_id <> (SELECT thread_id FROM target)`;
  return [
    db
      .prepare(
        `${merge}
        INSERT INTO item_tags (account_id, item_id, tag_id)
        SELECT survivor.account_id, survivor.item_id, t.tag_id
        FROM mail_conversations survivor
        JOIN mail_conversations loser ON loser.account_id = survivor.account_id AND loser.mailbox_id = survivor.mailbox_id
        JOIN item_tags t ON t.account_id = loser.account_id AND t.item_id = loser.item_id
        WHERE survivor.mailbox_id = ${mailbox} AND survivor.thread_id = (SELECT thread_id FROM target)
          AND loser.thread_id IN matched AND loser.thread_id <> survivor.thread_id
        ON CONFLICT (account_id, item_id, tag_id) DO NOTHING`,
      )
      .bind(aliases),
    db
      .prepare(
        `${merge}
        UPDATE items SET revision = ?2 WHERE (account_id, id) = (
          SELECT account_id, item_id FROM mail_conversations
          WHERE mailbox_id = ${mailbox} AND thread_id = (SELECT thread_id FROM target)
        ) AND EXISTS (SELECT 1 FROM mail_conversations WHERE ${losing})`,
      )
      .bind(aliases, crypto.randomUUID()),
    db
      .prepare(
        `${merge}
        DELETE FROM items WHERE (account_id, id) IN (
          SELECT account_id, item_id FROM mail_conversations WHERE ${losing}
        )`,
      )
      .bind(aliases),
  ];
};
