import { mailboxSql, type MailDatabase } from "./mailbox.ts";
import type { R2Bucket, R2Object } from "@cloudflare/workers-types";
import { Schema } from "effect";
import {
  InboxMessageId,
  isInboxView,
  MailMessageId,
  MailPeople,
  type ConversationMessage,
  type MailFilters,
  type MailFolder,
  type MailPerson,
  type MailboxView,
  type SenderRule,
} from "../inbox-contract.ts";
import { conversationPeople, conversationSubject } from "../inbox-display.ts";
import { normalizePersonEmail, PersonEmail } from "../people-contract.ts";
import {
  applySenderAppearance,
  senderAppearanceRules,
  withSenderAppearances,
} from "./mail-sender-appearance.ts";
import {
  type ContactFilters,
  contactFilterQuery,
  matchesContactFilters,
  resolveContactFilters,
} from "./mail-conversation-filters.ts";
import { mailPeople } from "./mail-people.ts";
import { indexMailBodyStatements, mailBodyExcerpt } from "./mail-body-index.ts";
import { enqueueMailPush, pushLifetimeMs } from "./push-store.ts";
import {
  indexConversationItem,
  mergeConversationItems,
  removeConversationItems,
} from "./mail-conversation-items.ts";

export type IndexedMail = ConversationMessage & {
  messageIds: readonly string[];
  originalId?: string;
  listMail?: boolean;
  initialArchived?: boolean;
  envelopeRecipient?: string;
  notifyIncoming?: boolean;
  bodyText?: string;
};

export const isMailingList = (listId: string | null | undefined) =>
  listId?.match(/<([^<>\s]+)>/u)?.[1]?.includes(".") ?? false;

const indexedSender = (alias: "m" | "incoming") =>
  `lower(trim(coalesce(json_extract(${alias}.people, '$.sender.address'), ${alias}.sender)))`;
const senderPriority = (alias: "m" | "incoming") =>
  `SELECT priority FROM mail_sender_rules WHERE mailbox_id = ${alias}.mailbox_id AND address = ${indexedSender(alias)}`;
const isPersonEmail = Schema.is(PersonEmail);
const senderRule = (
  address: string | null | undefined,
  priority: "signal" | "noise" | null | undefined,
): typeof SenderRule.Type | undefined =>
  isPersonEmail(address)
    ? { address, priority: priority ?? "automatic" }
    : undefined;

const localIdentity = (id: string) => `mail:${id}`;
const hashMessageId = async (id: string) => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(id),
  );
  return `rfc:${new Uint8Array(bytes).toHex()}`;
};

export const indexMailStatements = async (
  db: MailDatabase,
  mail: IndexedMail,
  reopensArchive = false,
) => {
  const scope = mailboxSql(db);
  const matchingThreads = `SELECT thread_id FROM mail_index_keys WHERE mailbox_id = ${scope} AND identity IN (SELECT value FROM json_each(?1))`;
  // Keep an existing item if a message also matches a thread with only
  // tombstones. Otherwise use the same deterministic thread ordering.
  const threadsToMerge = `WITH matched AS MATERIALIZED (${matchingThreads}), target(thread_id) AS MATERIALIZED (
    SELECT coalesce(min(c.thread_id), min(m.thread_id)) FROM matched m
    LEFT JOIN mail_conversations c ON c.mailbox_id = ${scope} AND c.thread_id = m.thread_id
  )`;
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
    listMail,
  } = mail;
  const aliases = JSON.stringify([
    localIdentity(id),
    ...(originalId ? [localIdentity(originalId)] : []),
    ...(await Promise.all(messageIds.map(hashMessageId))),
  ]);
  // D1 batches run atomically. Merge memberships, items and aliases together.
  return [
    db
      .prepare(
        `
      ${threadsToMerge}
      INSERT OR IGNORE INTO mail_index_keys (mailbox_id, identity, thread_id)
      SELECT ${scope}, value, coalesce((SELECT thread_id FROM target), ?2) FROM json_each(?1)
    `,
      )
      .bind(aliases, id),
    db
      .prepare(
        `
      ${threadsToMerge}
      UPDATE mail_index_messages SET thread_id = (SELECT * FROM target)
      WHERE mailbox_id = ${mailboxSql(db)} AND thread_id IN matched AND thread_id <> (SELECT * FROM target)
    `,
      )
      .bind(aliases),
    ...mergeConversationItems(db, threadsToMerge, aliases),
    db
      .prepare(
        `
      ${threadsToMerge}
      UPDATE mail_index_keys SET thread_id = (SELECT * FROM target)
      WHERE mailbox_id = ${mailboxSql(db)} AND thread_id IN matched AND thread_id <> (SELECT * FROM target)
    `,
      )
      .bind(aliases),
    db
      .prepare(
        `
      INSERT INTO mail_index_messages (mailbox_id, envelope_recipient, id, thread_id, folder, sender, recipient, subject, timestamp, unread, people, archived, list_mail)
      VALUES (${mailboxSql(db)}, ?13, ?1, (SELECT thread_id FROM mail_index_keys WHERE mailbox_id = ${mailboxSql(db)} AND identity = ?2), ?3, ?4, ?5, ?6, ?7, ?8, ?9,
        CASE WHEN ?3 = 'inbox' AND ?12 IS NOT NULL THEN ?12
        WHEN ?3 = 'inbox' AND ?10 = 0 THEN coalesce((
          SELECT CASE WHEN (timestamp, id) > (?7, ?1) THEN archived ELSE 0 END
          FROM mail_index_messages
          WHERE mailbox_id = ${mailboxSql(db)} AND thread_id = (SELECT thread_id FROM mail_index_keys WHERE mailbox_id = ${mailboxSql(db)} AND identity = ?2)
            AND folder = 'inbox' AND deleted = 0
          ORDER BY timestamp DESC, id DESC LIMIT 1
        ), 0) ELSE 0 END, ?11
      )
      ON CONFLICT(mailbox_id, id) DO UPDATE SET
        people = coalesce(mail_index_messages.people, excluded.people),
        list_mail = coalesce(mail_index_messages.list_mail, excluded.list_mail)
      WHERE mail_index_messages.deleted = 0 AND (
        (mail_index_messages.people IS NULL AND excluded.people IS NOT NULL) OR
        (mail_index_messages.list_mail IS NULL AND excluded.list_mail IS NOT NULL)
      )
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
        reopensArchive ? 1 : 0,
        listMail === undefined ? null : Number(listMail),
        mail.initialArchived === undefined
          ? null
          : Number(mail.initialArchived),
        mail.envelopeRecipient ?? null,
      ),
    ...indexConversationItem(db, id),
    ...(mail.bodyText === undefined
      ? []
      : indexMailBodyStatements(db, id, mail.bodyText)),
    // Incoming mail and merges with an active conversation reopen the whole
    // thread. Keep that state even if the new incoming message is later deleted.
    db
      .prepare(
        `
      UPDATE mail_index_messages AS member SET archived = 0
      WHERE mailbox_id = ${mailboxSql(db)} AND thread_id = (SELECT thread_id FROM mail_index_keys WHERE mailbox_id = ${mailboxSql(db)} AND identity = ?)
        AND folder = 'inbox' AND deleted = 0 AND archived = 1
        AND EXISTS (
          SELECT 1 FROM mail_index_messages active
          WHERE active.mailbox_id = member.mailbox_id AND active.thread_id = member.thread_id AND active.folder = 'inbox'
            AND active.deleted = 0 AND active.archived = 0
        )
    `,
      )
      .bind(localIdentity(id)),
    ...(mail.notifyIncoming && folder === "inbox"
      ? [enqueueMailPush(db, id, timestamp)]
      : []),
  ];
};

export const indexMail = async (
  db: MailDatabase,
  mail: IndexedMail,
  options?: { reopensArchive: boolean },
) => {
  await db.batch(await indexMailStatements(db, mail, options?.reopensArchive));
};

export const removeIndexedMail = async (
  db: MailDatabase,
  messages: readonly { folder: MailFolder; id: string }[],
) => {
  const mailbox = mailboxSql(db);
  const ids = JSON.stringify(messages.map(({ id }) => id));
  // Retain the opaque ID to prevent an in-flight R2 scan from recreating this row.
  await db.batch([
    db
      .prepare(
        `DELETE FROM mail_body_text
         WHERE mailbox_id = ${mailbox} AND message_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(ids),
    db
      .prepare(
        `
      INSERT INTO mail_index_messages (mailbox_id, id, thread_id, folder, sender, recipient, subject, timestamp, deleted)
      SELECT ${mailbox}, value ->> 'id', value ->> 'id', value ->> 'folder', '', '', '', 0, 1
      FROM json_each(?) WHERE true
      ON CONFLICT(mailbox_id, id) DO UPDATE SET sender = '', recipient = '', envelope_recipient = NULL,
        subject = '', timestamp = 0, deleted = 1, deleted_at = NULL, trash_batch = NULL,
        unread = 0, archived = 0, people = NULL, list_mail = NULL, body_preview = NULL, body_indexed = 0
    `,
      )
      .bind(JSON.stringify(messages)),
    ...removeConversationItems(db, ids),
  ]);
};

const isInboxId = Schema.is(InboxMessageId);
const isMailId = Schema.is(MailMessageId);
const pageSize = 20;
const scanSize = 12;
const inboxIndexScan = "inbox:list-mail";
const sentIndexScan = "sent:people";

const inboxUnreadMessages =
  "folder = 'inbox' AND deleted = 0 AND unread = 1 AND archived = 0";

export const inboxUnread = async (db: MailDatabase) => {
  const row = await db
    .prepare(
      `
    SELECT count(*) AS unreadCount FROM mail_index_messages
    WHERE mailbox_id = ${mailboxSql(db)} AND ${inboxUnreadMessages}
  `,
    )
    .first<{ unreadCount: number }>();
  return { unreadCount: row?.unreadCount ?? 0 };
};

export const inboxMessageUnread = async (db: MailDatabase, id: string) => {
  const row = await db
    .prepare(
      `
    SELECT unread FROM mail_index_messages
    WHERE mailbox_id = ${mailboxSql(db)} AND id = ? AND folder = 'inbox' AND deleted = 0
  `,
    )
    .bind(id)
    .first<{ unread: number }>();
  return row ? row.unread === 1 : null;
};

const updateInboxUnread = (db: MailDatabase, id: string, unread: boolean) =>
  db
    .prepare(
      `
    UPDATE mail_index_messages SET unread = ?2
    WHERE mailbox_id = ${mailboxSql(db)} AND id = ?1 AND folder = 'inbox' AND deleted = 0 AND unread <> ?2
    RETURNING id
  `,
    )
    .bind(id, Number(unread));

export const setInboxUnread = async (
  db: MailDatabase,
  id: string,
  unread: boolean,
) => {
  const updated = await updateInboxUnread(db, id, unread).first();
  if (updated) return "changed";
  return (await inboxMessageUnread(db, id)) === null ? "missing" : "unchanged";
};

export const setInboxUnreadStatus = async (
  db: MailDatabase,
  id: string,
  unread: boolean,
) => {
  const scope = mailboxSql(db);
  const status = db
    .prepare(
      `WITH incoming AS (
      SELECT id, unread FROM mail_index_messages
      WHERE mailbox_id = ${scope} AND thread_id = (
        SELECT thread_id FROM mail_index_messages WHERE mailbox_id = ${scope} AND id = ?1
      ) AND folder = 'inbox' AND deleted = 0
      ORDER BY timestamp DESC, id DESC
    )
    SELECT unread, (SELECT id FROM incoming LIMIT 1) AS latestIncomingId,
      (SELECT json_group_array(id) FROM incoming WHERE unread = 1) AS unreadIncomingIds,
      (SELECT count(*) FROM mail_index_messages WHERE mailbox_id = ${scope}
        AND ${inboxUnreadMessages}) AS unreadCount,
      coalesce((SELECT version FROM mail_changes WHERE mailbox_id = ${scope}), 0) AS version
    FROM incoming WHERE id = ?1`,
    )
    .bind(id);
  // Read the counts and the version in the same transaction as the write.
  const [updated, snapshot] = await db.batch<{
    unread: number;
    latestIncomingId: string;
    unreadIncomingIds: string;
    unreadCount: number;
    version: number;
  }>([updateInboxUnread(db, id, unread), status]);
  const row = snapshot?.results[0];
  if (!row) return null;
  return {
    ...row,
    unread: row.unread === 1,
    unreadIncomingIds: JSON.parse(row.unreadIncomingIds) as string[],
    changed: Boolean(updated?.results.length),
  };
};

export const setThreadArchived = async (
  db: MailDatabase,
  id: string,
  archived: boolean,
  { anchorId = id, requireLatest = false } = {},
) => {
  const mailbox = mailboxSql(db);
  const thread = requireLatest
    ? `SELECT thread_id FROM mail_index_messages WHERE mailbox_id = ${mailbox} AND id = ?1 AND folder = 'inbox' AND deleted = 0`
    : `SELECT thread_id FROM mail_index_keys WHERE mailbox_id = ${mailbox} AND identity = ?1`;
  const newestIncoming = `
    SELECT id, archived FROM mail_index_messages
    WHERE mailbox_id = ${mailbox} AND thread_id = (${thread})
      AND folder = 'inbox' AND deleted = 0
    ORDER BY timestamp DESC, id DESC LIMIT 1
  `;
  const anchor = requireLatest ? id : localIdentity(anchorId);
  const state = Number(archived);
  const update = db
    .prepare(
      `
    UPDATE mail_index_messages SET archived = ?2
    WHERE mailbox_id = ${mailbox} AND thread_id = (${thread})
      AND folder = 'inbox' AND deleted = 0 AND archived <> ?2
      AND (${requireLatest ? "" : "?2 = 0 OR "}?3 = (SELECT id FROM (${newestIncoming})))
    RETURNING id, archived
  `,
    )
    .bind(anchor, state, id);
  const readCurrent = db.prepare(newestIncoming).bind(anchor);
  type ArchiveRow = { id: string; archived: number };
  if (requireLatest) {
    // Classify a no-op in the same transaction that checked the precondition.
    const [changed, newest] = await db.batch<ArchiveRow>([update, readCurrent]);
    if (changed?.results.length) return "changed";
    const current = newest?.results[0];
    if (!current) return "missing";
    return current.id === id && current.archived === state
      ? "unchanged"
      : "stale";
  }
  if (await update.first<ArchiveRow>()) return "changed";
  const current = await readCurrent.first<ArchiveRow>();
  if (!current) return "missing";
  return current.archived === state ? "unchanged" : "stale";
};

type ConversationView = Exclude<MailboxView, "sent">;

export const conversationCursor = (
  cursor: string | undefined,
  view: ConversationView,
) => {
  if (cursor === undefined) return { timestamp: null, id: "" };
  const [time, id, extra] = cursor.split("/");
  const timestamp = Number(time);
  return extra === undefined &&
    (view === "all" ? isMailId(id) : isInboxId(id)) &&
    /^\d+$/u.test(time ?? "") &&
    Number.isSafeInteger(timestamp)
    ? { timestamp, id }
    : null;
};

type IndexedThreadMember = Pick<
  ConversationMessage,
  "id" | "from" | "to" | "subject" | "timestamp" | "folder"
> & {
  people: string | null;
  unread: number;
};

const decodePeople = Schema.decodeUnknownOption(
  Schema.fromJsonString(MailPeople),
);

const withPeople = <
  Message extends { from: string; to: string; people: string | null },
>({
  people,
  ...message
}: Message) => {
  const decoded = decodePeople(people);
  return {
    ...message,
    people:
      decoded._tag === "Some"
        ? decoded.value
        : mailPeople(() => undefined, message.from, message.to),
  };
};

type MailCursor = NonNullable<ReturnType<typeof conversationCursor>>;
type MailSearch = {
  view: Exclude<MailboxView, "trash">;
  status: MailFilters["status"];
  subjectWords: string[];
  bodyWords?: string[];
  participantEmail: string | null;
  contacts: ContactFilters;
  fromInclusive: number | null;
  toExclusive: number | null;
  cursor: MailCursor;
  limit: number;
};

const indexedMessageFields = `m.id, m.folder, m.subject, m.timestamp,
  m.sender AS "from", m.recipient AS "to", m.people, m.unread`;
const presentMessage = <Message extends IndexedThreadMember>({
  unread,
  ...message
}: Message) => ({ ...withPeople(message), unread: unread === 1 });

export const mailIndexCoverage = async (db: MailDatabase) => {
  const row = await db
    .prepare(
      `SELECT count(*) AS ready FROM mail_index_scans
       WHERE mailbox_id = ${mailboxSql(db)} AND folder IN (?, ?) AND ready = 1`,
    )
    .bind(inboxIndexScan, sentIndexScan)
    .first<{ ready: number }>();
  return row?.ready === 2 ? "complete" : "incomplete";
};

export const searchIndexedMail = async (
  db: MailDatabase,
  query: MailSearch,
) => {
  const { people, companies } = query.contacts;
  if (
    people?.size === 0 ||
    (companies?.emails.size === 0 && companies.domains.size === 0)
  )
    return [];
  const contact = contactFilterQuery(query.contacts);
  const bodyWords = query.bodyWords;
  const scope = mailboxSql(db);
  // Use the longest query term to narrow the phrase check within this mailbox.
  const anchor = bodyWords?.reduce((longest, word) =>
    word.length > longest.length ? word : longest,
  );
  const inThread = (alias: string) =>
    `${alias}.mailbox_id = m.mailbox_id AND ${alias}.thread_id = m.thread_id AND ${alias}.deleted = 0`;
  const matchesMessage = (alias: "m" | "newer") => `
    (?3 IS NULL OR ${alias}.timestamp >= ?3)
    AND (?4 IS NULL OR ${alias}.timestamp < ?4)
    AND NOT EXISTS (
      SELECT 1 FROM json_each(?1) word WHERE instr(lower(${alias}.subject), lower(word.value)) = 0
    )
    AND (?2 IS NULL OR lower(trim(${alias}.envelope_recipient)) = ?2 OR EXISTS (
      SELECT 1 FROM json_each(${alias}.people, '$.members') person
      WHERE lower(trim(json_extract(person.value, '$.address'))) = ?2
    ) OR (${alias}.people IS NULL AND
      (lower(trim(${alias}.sender)) = ?2 OR lower(trim(${alias}.recipient)) = ?2)
    ))
  `;
  const unreadMembers = `FROM mail_index_messages member
    WHERE ${inThread("member")} AND member.folder = 'inbox' AND member.unread = 1`;
  const incomingPriority = `coalesce((${senderPriority("incoming")}),
    CASE WHEN incoming.list_mail = 1 THEN 'noise' ELSE 'signal' END)`;
  const viewFilters = {
    all: "",
    sent: `AND EXISTS (SELECT 1 FROM mail_index_messages member
      WHERE ${inThread("member")} AND member.folder = 'sent')`,
    archive: "AND incoming.archived = 1",
    inbox: `AND incoming.archived = 0 AND ${incomingPriority} = 'signal'`,
    noise: `AND incoming.archived = 0 AND ${incomingPriority} = 'noise'`,
  };
  const statement = db.prepare(
    `
      WITH page_size(size) AS (VALUES (?7))
      ${
        bodyWords
          ? `, body_matches AS MATERIALIZED (
        SELECT term.message_id
        FROM mail_body_terms term
        JOIN mail_body_text body ON body.mailbox_id = term.mailbox_id AND body.message_id = term.message_id
        WHERE term.mailbox_id = ${scope} AND term.term = ?8 AND instr(body.words, ?9) > 0
      )`
          : ""
      }
      SELECT ${indexedMessageFields}, incoming.id AS latestIncomingId,
        ${bodyWords ? "body.body" : "NULL"} AS bodyText,
        coalesce(incoming.archived, 0) AS archived,
        (SELECT count(*) ${unreadMembers}) AS unreadCount,
        (SELECT count(*) FROM mail_index_messages member WHERE ${inThread("member")}) AS messageCount,
        (SELECT member.timestamp FROM mail_index_messages member WHERE ${inThread("member")}
          ORDER BY member.timestamp DESC, member.id DESC LIMIT 1) AS lastMessageAt,
        ${
          contact.hasLegacyMembers
            ? `CASE WHEN ${contact.hasLegacyMembers} THEN (
            SELECT json_group_array(json_object(
              'from', member.sender, 'to', member.recipient, 'people', member.people
            )) FROM mail_index_messages member WHERE ${inThread("member")}
          ) END`
            : "NULL"
        } AS legacyMembers
      FROM mail_index_messages m
      ${
        bodyWords
          ? `JOIN body_matches matched ON matched.message_id = m.id
      JOIN mail_body_text body ON body.mailbox_id = m.mailbox_id AND body.message_id = m.id`
          : ""
      }
      LEFT JOIN mail_index_messages incoming ON incoming.mailbox_id = m.mailbox_id AND incoming.id = (
        SELECT member.id FROM mail_index_messages member
        WHERE ${inThread("member")} AND member.folder = 'inbox'
        ORDER BY member.timestamp DESC, member.id DESC LIMIT 1
      )
      WHERE m.mailbox_id = ${scope} AND m.deleted = 0
        AND (?5 IS NULL OR (m.timestamp, m.id) < (?5, ?6))
        AND ${matchesMessage("m")}
        AND NOT EXISTS (
          SELECT 1 FROM mail_index_messages newer
          WHERE ${inThread("newer")} AND (newer.timestamp, newer.id) > (m.timestamp, m.id)
            AND ${matchesMessage("newer")}
            ${bodyWords ? "AND newer.id IN (SELECT message_id FROM body_matches)" : ""}
        )
        ${viewFilters[query.view]}
        ${query.status === "all" ? "" : `AND ${query.status === "read" ? "NOT " : ""}EXISTS (SELECT 1 ${unreadMembers})`}
        ${contact.where}
      ORDER BY m.timestamp DESC, m.id DESC LIMIT (SELECT size FROM page_size)
    `,
  );
  const readPage = (cursor: MailCursor, limit: number) =>
    statement
      .bind(
        JSON.stringify(query.subjectWords),
        query.participantEmail,
        query.fromInclusive,
        query.toExclusive,
        cursor.timestamp,
        cursor.id,
        limit,
        ...(bodyWords ? [anchor!, ` ${bodyWords.join(" ")} `] : []),
        ...contact.values,
      )
      .all<
        IndexedThreadMember & {
          archived: number;
          latestIncomingId: string | null;
          unreadCount: number;
          messageCount: number;
          lastMessageAt: number;
          legacyMembers: string | null;
          bodyText: string | null;
        }
      >();
  const matches = [];
  let cursor = query.cursor;
  let limit = query.limit;
  while (matches.length < query.limit) {
    const { results } = await readPage(cursor, limit);
    for (const { legacyMembers, bodyText, ...row } of results) {
      if (legacyMembers) {
        const members = JSON.parse(legacyMembers) as Pick<
          IndexedThreadMember,
          "from" | "to" | "people"
        >[];
        if (
          !matchesContactFilters(
            query.contacts,
            members.flatMap((member) => withPeople(member).people.members),
          )
        )
          continue;
      }
      matches.push(
        presentMessage({
          ...row,
          excerpt:
            bodyWords && bodyText
              ? mailBodyExcerpt(bodyText, bodyWords)
              : undefined,
        }),
      );
      if (matches.length === query.limit) break;
    }
    const last = results.at(-1);
    if (!last || results.length < limit) break;
    cursor = { timestamp: last.timestamp, id: last.id };
    limit = bodyWords ? 24 : 100;
  }
  return matches;
};

export const readIndexedMailMessage = async (db: MailDatabase, id: string) => {
  const row = await db
    .prepare(
      `SELECT ${indexedMessageFields}, (
         SELECT incoming.id FROM mail_index_messages incoming
         WHERE incoming.mailbox_id = m.mailbox_id AND incoming.thread_id = m.thread_id
           AND incoming.folder = 'inbox' AND incoming.deleted = 0
         ORDER BY incoming.timestamp DESC, incoming.id DESC LIMIT 1
       ) AS latestIncomingId
       FROM mail_index_messages m
       WHERE m.mailbox_id = ${mailboxSql(db)} AND m.id = ? AND m.deleted = 0`,
    )
    .bind(id)
    .first<IndexedThreadMember & { latestIncomingId: string | null }>();
  return row && presentMessage(row);
};

export const readIndexedThreadPage = async (
  db: MailDatabase,
  id: string,
  cursor: MailCursor,
  limit: number,
) => {
  const { results } = await db
    .prepare(
      `SELECT ${indexedMessageFields}, m.body_preview AS bodyPreview
       FROM mail_index_messages m
       WHERE m.mailbox_id = ${mailboxSql(db)} AND m.deleted = 0
         AND m.thread_id = (
           SELECT thread_id FROM mail_index_messages
           WHERE mailbox_id = ${mailboxSql(db)} AND id = ?1 AND deleted = 0
         )
         AND (?2 IS NULL OR (m.timestamp, m.id) > (?2, ?3))
       ORDER BY m.timestamp, m.id LIMIT ?4`,
    )
    .bind(id, cursor.timestamp, cursor.id, limit)
    .all<IndexedThreadMember & { bodyPreview: string | null }>();
  return results.map(presentMessage);
};

export const listConversations = async (
  db: MailDatabase,
  cursor: NonNullable<ReturnType<typeof conversationCursor>>,
  view: ConversationView,
  filters?: MailFilters,
  mailboxAddresses: readonly string[] = [],
  anchor?: string,
) => {
  const all = view === "all";
  const incoming = all ? "incoming" : "m";
  const contacts = filters
    ? await resolveContactFilters(db, filters, mailboxAddresses)
    : {};
  const contact = contactFilterQuery(contacts);
  const status = filters?.status ?? "all";
  const unreadMembers = `FROM mail_index_messages member
    WHERE member.mailbox_id = m.mailbox_id AND member.thread_id = m.thread_id
      AND member.folder = 'inbox' AND member.deleted = 0 AND member.unread = 1`;
  const statement = db.prepare(
    `
    WITH page_size(size) AS (VALUES (?3))
    SELECT m.id, m.sender AS "from", m.timestamp AS sortAt,
           ${all ? "incoming.id" : "m.id"} AS latestIncomingId,
           ${all ? "coalesce(incoming.archived, 0)" : "m.archived"} AS archived,
           ${indexedSender(incoming)} AS senderAddress,
           (${senderPriority(incoming)}) AS senderPriority,
           (SELECT json_group_array(json_object(
              'id', member.id, 'from', member.sender, 'to', member.recipient, 'subject', member.subject,
              'timestamp', member.timestamp, 'people', member.people, 'folder', member.folder,
              'unread', member.unread, 'archived', member.archived
            ) ORDER BY member.timestamp, member.id)
            FROM mail_index_messages member
            WHERE member.mailbox_id = m.mailbox_id AND member.thread_id = m.thread_id AND member.deleted = 0) AS metadata,
           (SELECT count(*) ${unreadMembers}) AS unreadCount
    FROM mail_index_messages m
    ${
      all
        ? `LEFT JOIN mail_index_messages incoming ON incoming.mailbox_id = m.mailbox_id AND incoming.id = (
      SELECT member.id FROM mail_index_messages member
      WHERE member.mailbox_id = m.mailbox_id AND member.thread_id = m.thread_id AND member.folder = 'inbox' AND member.deleted = 0
      ORDER BY member.timestamp DESC, member.id DESC LIMIT 1
    )`
        : ""
    }
    WHERE m.mailbox_id = ${mailboxSql(db)} AND m.deleted = 0 ${all ? "" : "AND m.folder = 'inbox' AND m.archived = ?4"}
      ${isInboxView(view) ? `AND coalesce((${senderPriority("m")}), CASE WHEN m.list_mail = 1 THEN 'noise' ELSE 'signal' END) = ?5` : ""}
      AND (?1 IS NULL OR (m.timestamp, m.id) < (?1, ?2))
      AND NOT EXISTS (
        SELECT 1 FROM mail_index_messages newer
        WHERE newer.mailbox_id = m.mailbox_id AND newer.thread_id = m.thread_id AND newer.deleted = 0
          ${all ? "" : "AND newer.folder = 'inbox'"}
          AND (newer.timestamp, newer.id) > (m.timestamp, m.id)
      )
      ${status === "all" ? "" : `AND ${status === "read" ? "NOT " : ""}EXISTS (SELECT 1 ${unreadMembers})`}
      ${contact.where}
      ${
        anchor
          ? `AND m.thread_id = (
        SELECT thread_id FROM mail_index_messages WHERE mailbox_id = ${mailboxSql(db)} AND id = ? AND deleted = 0
      )`
          : ""
      }
    ORDER BY m.timestamp DESC, m.id DESC LIMIT (SELECT size FROM page_size)
  `,
  );
  const readPage = (after: typeof cursor, limit: number) =>
    statement
      .bind(
        after.timestamp,
        after.id,
        limit,
        ...(all ? [] : [view === "archive" ? 1 : 0]),
        ...(isInboxView(view) ? [view === "noise" ? "noise" : "signal"] : []),
        ...contact.values,
        ...(anchor ? [anchor] : []),
      )
      .all<{
        id: string;
        from: string;
        sortAt: number;
        latestIncomingId: string | null;
        archived: number;
        senderAddress: string | null;
        senderPriority: "signal" | "noise" | null;
        metadata: string;
        unreadCount: number;
      }>();
  const matches = [];
  let after = cursor;
  let limit = pageSize + 1;
  while (matches.length < pageSize + 1) {
    const { results } = await readPage(after, limit);
    for (const { metadata, ...row } of results) {
      const indexed = JSON.parse(metadata) as (IndexedThreadMember & {
        archived: number;
      })[];
      const members = indexed.map(withPeople);
      if (
        contact.where &&
        indexed.some(({ people }) => people === null) &&
        !matchesContactFilters(
          contacts,
          members.flatMap(({ people }) => people.members),
        )
      )
        continue;
      matches.push({ row, members });
      if (matches.length > pageSize) break;
    }
    const last = results.at(-1);
    if (!last || results.length < limit) break;
    after = { timestamp: last.sortAt, id: last.id };
    // Amortize the extra queries if we have to check a stretch of legacy rows.
    limit = 100;
  }
  const page = matches.slice(0, pageSize);
  const rules = await senderAppearanceRules(
    db,
    page.flatMap(({ members }) =>
      members.flatMap(({ people }) =>
        people.sender ? [people.sender.address] : [],
      ),
    ),
  );
  const messages = page.map(
    ({
      row: { sortAt, archived, senderAddress, senderPriority, ...row },
      members: rawMembers,
    }) => {
      const rule = senderRule(senderAddress, senderPriority);
      const members = rawMembers.map((member) => ({
        ...member,
        people: applySenderAppearance(member.people, rules),
      }));
      const lastMessage = members.at(-1);
      const avatarMessage =
        members.find(
          (member) => member.folder === "inbox" && member.unread === 1,
        ) ??
        members.findLast((member) => member.folder === "inbox") ??
        lastMessage;
      const avatarSender = avatarMessage?.people.sender;
      const senders = new Map<string, MailPerson>();
      const folder = members.some(({ folder }) => folder === "inbox")
        ? "inbox"
        : "sent";
      for (const member of members.toReversed()) {
        const sender = member.people.sender;
        if (!sender || member.folder !== folder) continue;
        const key = normalizePersonEmail(sender.address);
        const previous = senders.get(key);
        if (!previous || (!previous.name && sender.name))
          senders.set(key, sender);
      }
      return {
        ...row,
        archived: archived === 1,
        unreadIncomingIds: members
          .filter(({ folder, unread }) => folder === "inbox" && unread === 1)
          .map(({ id }) => id),
        archivedIncomingIds: members
          .filter(
            ({ folder, archived }) => folder === "inbox" && archived === 1,
          )
          .map(({ id }) => id),
        ...(rule ? { senderRule: rule } : {}),
        ...(all ? {} : { receivedAt: sortAt }),
        subject: conversationSubject(members),
        lastMessageAt: lastMessage?.timestamp ?? sortAt,
        lastMessageId: lastMessage?.id ?? row.id,
        messageCount: members.length,
        participants: conversationPeople(members),
        senders: [...senders.values()],
        ...(avatarSender ? { avatarSender } : {}),
      };
    },
  );
  const last = page.at(-1)?.row;
  return {
    messages,
    cursor:
      last && matches.length > pageSize ? `${last.sortAt}/${last.id}` : null,
  };
};

export const readThread = async (db: MailDatabase, id: string) => {
  const { results } = await db
    .prepare(
      `
    SELECT ${indexedMessageFields}, archived,
           CASE WHEN m.folder = 'inbox' THEN ${indexedSender("m")} END AS senderAddress,
           CASE WHEN m.folder = 'inbox' THEN (${senderPriority("m")}) END AS senderPriority
    FROM mail_index_messages m
    WHERE mailbox_id = ${mailboxSql(db)} AND thread_id = (SELECT thread_id FROM mail_index_keys WHERE mailbox_id = ${mailboxSql(db)} AND identity = ?)
      AND deleted = 0
    ORDER BY timestamp, id
  `,
    )
    .bind(localIdentity(id))
    .all<
      IndexedThreadMember & {
        archived: number;
        senderAddress: string | null;
        senderPriority: "signal" | "noise" | null;
      }
    >();
  const incoming = results.findLast(({ folder }) => folder === "inbox");
  const rule = senderRule(incoming?.senderAddress, incoming?.senderPriority);
  return {
    archived: results.some(({ archived }) => archived === 1),
    ...(rule ? { senderRule: rule } : {}),
    messages: await withSenderAppearances(
      db,
      results.map(
        ({
          archived,
          senderAddress: _senderAddress,
          senderPriority: _senderPriority,
          ...message
        }) => ({ ...presentMessage(message), archived: archived === 1 }),
      ),
    ),
  };
};

export const readNoiseSenders = async (db: MailDatabase) => {
  const { results } = await db
    .prepare(
      `SELECT address FROM mail_sender_rules WHERE mailbox_id = ${mailboxSql(db)} AND priority = 'noise' ORDER BY address`,
    )
    .all<{ address: string }>();
  return { addresses: results.map(({ address }) => address) };
};

export const setSenderRule = (
  db: MailDatabase,
  { address, priority }: typeof SenderRule.Type,
) => {
  const sender = normalizePersonEmail(address);
  return priority === "automatic"
    ? db
        .prepare(
          `DELETE FROM mail_sender_rules WHERE mailbox_id = ${mailboxSql(db)} AND address = ?`,
        )
        .bind(sender)
        .run()
    : db
        .prepare(
          `
        INSERT INTO mail_sender_rules (mailbox_id, address, priority) VALUES (${mailboxSql(db)}, ?, ?)
        ON CONFLICT(mailbox_id, address) DO UPDATE SET priority = excluded.priority
      `,
        )
        .bind(sender, priority)
        .run();
};

export const scanMail = async (
  db: MailDatabase,
  folder: MailFolder,
  bucket: R2Bucket,
  describe: (object: R2Object) => Promise<IndexedMail | null>,
  reconcile: boolean,
  incomingOnly = false,
  requirePeople = false,
) => {
  const scanId = incomingOnly
    ? "inbox:push"
    : folder === "inbox"
      ? inboxIndexScan
      : sentIndexScan;
  const state = await db
    .prepare(
      `SELECT cursor, scanned_at AS scannedAt, ready FROM mail_index_scans WHERE mailbox_id = ${mailboxSql(db)} AND folder = ?`,
    )
    .bind(scanId)
    .first<{ cursor: string | null; scannedAt: number; ready: number }>();
  if (state?.ready && !reconcile) return false;
  // A mailbox indexed by the older scan can be used while list headers backfill.
  const alreadyIndexed =
    folder === "inbox" && !state?.ready && !requirePeople
      ? await db
          .prepare(
            `SELECT ready FROM mail_index_scans WHERE mailbox_id = ${mailboxSql(db)} AND folder = 'inbox:people'`,
          )
          .first<{ ready: number }>()
      : null;
  const page = await bucket.list({
    limit: scanSize,
    ...(incomingOnly ? { prefix: "0-" } : {}),
    cursor: state?.cursor ?? undefined,
    include: ["customMetadata"],
  });
  const cutoff = Date.now() - pushLifetimeMs;
  const objects = incomingOnly
    ? page.objects.filter(
        (object) =>
          object.customMetadata?.notifyIncoming === "1" &&
          object.uploaded.getTime() >= cutoff,
      )
    : page.objects;
  // The separate recent-mail scan cannot get stuck behind a historical import.
  // Native incoming keys sort by reversed receipt time; stop at the push TTL.
  const lastKey = page.objects.at(-1)?.key;
  const beforeCutoff =
    incomingOnly &&
    lastKey &&
    9_999_999_999_999 - Number(lastKey.slice(2, 15)) < cutoff;
  const more = page.truncated && !beforeCutoff;
  if (objects.length) {
    const { results } = await db
      .prepare(
        `SELECT id FROM mail_index_messages
         WHERE mailbox_id = ${mailboxSql(db)} AND (deleted <> 0 OR (people IS NOT NULL AND (folder = 'sent' OR list_mail IS NOT NULL)))
           AND id IN (SELECT value FROM json_each(?))`,
      )
      .bind(JSON.stringify(objects.map(({ key }) => key)))
      .all<{ id: string }>();
    const known = new Set(results.map(({ id }) => id));
    const missing = objects.filter(({ key }) => !known.has(key));
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
          await Promise.all(
            indexed.map((mail) => indexMailStatements(db, mail, incomingOnly)),
          )
        ).flat(),
      );
  }
  await db
    .prepare(
      `
    INSERT INTO mail_index_scans (mailbox_id, folder, cursor, scanned_at, ready) VALUES (${mailboxSql(db)}, ?1, ?2, ?3, ?4)
    ON CONFLICT(mailbox_id, folder) DO UPDATE SET cursor = excluded.cursor, scanned_at = excluded.scanned_at, ready = excluded.ready
    WHERE mail_index_scans.cursor IS ?5 AND mail_index_scans.scanned_at = ?6
  `,
    )
    .bind(
      scanId,
      more && page.truncated ? page.cursor : null,
      Date.now(),
      state?.ready || !page.truncated ? 1 : 0,
      state?.cursor ?? null,
      state?.scannedAt ?? -1,
    )
    .run();
  return page.truncated && !state?.ready && !alreadyIndexed?.ready;
};
