import { mailboxSql, type MailDatabase } from "./mailbox.ts";
import type { R2Bucket, R2Object } from "@cloudflare/workers-types";
import { Schema } from "effect";
import {
  InboxMessageId,
  isInboxView,
  MailMessageId,
  MailPeople,
  type ConversationMessage,
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
import { mailPeople } from "./mail-people.ts";

export type IndexedMail = ConversationMessage & {
  messageIds: readonly string[];
  originalId?: string;
  listMail?: boolean;
  initialArchived?: boolean;
  envelopeRecipient?: string;
};

export const isMailingList = (listId: string | null | undefined) =>
  listId?.match(/<([^<>\s]+)>/u)?.[1]?.includes(".") ?? false;

const indexedSender =
  "lower(trim(coalesce(json_extract(m.people, '$.sender.address'), m.sender)))";
const senderPriority = `SELECT priority FROM mail_sender_rules WHERE mailbox_id = m.mailbox_id AND address = ${indexedSender}`;
const isPersonEmail = Schema.is(PersonEmail);

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
  const canonicalThread = `SELECT min(thread_id) FROM (${matchingThreads})`;
  const threadsToMerge = `WITH matched AS MATERIALIZED (${matchingThreads}), target AS (SELECT min(thread_id) FROM matched)`;
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
  // D1 batches run atomically. Move both memberships and aliases when a
  // message connects conversations that were previously indexed separately.
  return [
    db
      .prepare(
        `
      INSERT OR IGNORE INTO mail_index_keys (mailbox_id, identity, thread_id)
      SELECT ${mailboxSql(db)}, value, coalesce((${canonicalThread}), ?2) FROM json_each(?1)
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
  folder: MailFolder,
  id: string,
) => {
  // Retain the opaque ID to prevent an in-flight R2 scan from recreating this row.
  await db
    .prepare(
      `
    INSERT INTO mail_index_messages (mailbox_id, id, thread_id, folder, sender, recipient, subject, timestamp, deleted)
    VALUES (${mailboxSql(db)}, ?1, ?1, ?2, '', '', '', 0, 1)
    ON CONFLICT(mailbox_id, id) DO UPDATE SET sender = '', recipient = '', envelope_recipient = NULL, subject = '', timestamp = 0, deleted = 1, deleted_at = NULL, unread = 0, people = NULL, body_preview = NULL
  `,
    )
    .bind(id, folder)
    .run();
};

const isInboxId = Schema.is(InboxMessageId);
const isMailId = Schema.is(MailMessageId);
const pageSize = 20;
const scanSize = 12;

export const inboxUnread = async (db: MailDatabase) => {
  const row = await db
    .prepare(
      `
    SELECT count(*) AS unreadCount FROM mail_index_messages
    WHERE mailbox_id = ${mailboxSql(db)} AND folder = 'inbox' AND deleted = 0 AND unread = 1 AND archived = 0
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

export const setInboxUnread = async (
  db: MailDatabase,
  id: string,
  unread: boolean,
) => {
  const updated = await db
    .prepare(
      `
    UPDATE mail_index_messages SET unread = ?2
    WHERE mailbox_id = ${mailboxSql(db)} AND id = ?1 AND folder = 'inbox' AND deleted = 0 AND unread <> ?2
    RETURNING id
  `,
    )
    .bind(id, unread ? 1 : 0)
    .first<{ id: string }>();
  if (updated) return "changed";
  return (await inboxMessageUnread(db, id)) === null ? "missing" : "unchanged";
};

export const setThreadArchived = async (
  db: MailDatabase,
  id: string,
  archived: boolean,
  anchorId = id,
) => {
  const newestIncoming = `
    SELECT id, archived FROM mail_index_messages
    WHERE mailbox_id = ${mailboxSql(db)} AND thread_id = (SELECT thread_id FROM mail_index_keys WHERE mailbox_id = ${mailboxSql(db)} AND identity = ?1)
      AND folder = 'inbox' AND deleted = 0
    ORDER BY timestamp DESC, id DESC LIMIT 1
  `;
  const identity = localIdentity(anchorId);
  const changed = await db
    .prepare(
      `
    UPDATE mail_index_messages SET archived = ?2
    WHERE mailbox_id = ${mailboxSql(db)} AND thread_id = (SELECT thread_id FROM mail_index_keys WHERE mailbox_id = ${mailboxSql(db)} AND identity = ?1)
      AND folder = 'inbox' AND deleted = 0 AND archived <> ?2
      AND (?2 = 0 OR ?3 = (SELECT id FROM (${newestIncoming})))
    RETURNING id
  `,
    )
    .bind(identity, archived ? 1 : 0, id)
    .first<{ id: string }>();
  if (changed) return "changed";
  const current = await db
    .prepare(newestIncoming)
    .bind(identity)
    .first<{ id: string; archived: number }>();
  if (!current) return "missing";
  return current.archived === (archived ? 1 : 0) ? "unchanged" : "stale";
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

export const listConversations = async (
  db: MailDatabase,
  cursor: NonNullable<ReturnType<typeof conversationCursor>>,
  view: ConversationView,
) => {
  const all = view === "all";
  const { results } = await db
    .prepare(
      `
    SELECT m.id, m.sender AS "from", m.timestamp AS sortAt,
           ${all ? "incoming.id" : "m.id"} AS latestIncomingId,
           ${all ? "coalesce(incoming.archived, 0)" : "m.archived"} AS archived,
           (SELECT json_group_array(json_object(
              'id', member.id, 'from', member.sender, 'to', member.recipient, 'subject', member.subject,
              'timestamp', member.timestamp, 'people', member.people, 'folder', member.folder, 'unread', member.unread
            ) ORDER BY member.timestamp, member.id)
            FROM mail_index_messages member
            WHERE member.mailbox_id = m.mailbox_id AND member.thread_id = m.thread_id AND member.deleted = 0) AS metadata,
           (SELECT count(*) FROM mail_index_messages member
            WHERE member.mailbox_id = m.mailbox_id AND member.thread_id = m.thread_id AND member.folder = 'inbox'
              AND member.deleted = 0 AND member.unread = 1) AS unreadCount
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
      ${isInboxView(view) ? `AND coalesce((${senderPriority}), CASE WHEN m.list_mail = 1 THEN 'noise' ELSE 'signal' END) = ?5` : ""}
      AND (?1 IS NULL OR (m.timestamp, m.id) < (?1, ?2))
      AND NOT EXISTS (
        SELECT 1 FROM mail_index_messages newer
        WHERE newer.mailbox_id = m.mailbox_id AND newer.thread_id = m.thread_id AND newer.deleted = 0
          ${all ? "" : "AND newer.folder = 'inbox'"}
          AND (newer.timestamp, newer.id) > (m.timestamp, m.id)
      )
    ORDER BY m.timestamp DESC, m.id DESC LIMIT ?3
  `,
    )
    .bind(
      cursor.timestamp,
      cursor.id,
      pageSize + 1,
      ...(all ? [] : [view === "archive" ? 1 : 0]),
      ...(isInboxView(view) ? [view === "noise" ? "noise" : "signal"] : []),
    )
    .all<{
      id: string;
      from: string;
      subject: string;
      sortAt: number;
      latestIncomingId: string | null;
      archived: number;
      metadata: string;
      unreadCount: number;
    }>();
  const memberSets = results.map(({ metadata }) =>
    (JSON.parse(metadata) as IndexedThreadMember[]).map(withPeople),
  );
  const rules = await senderAppearanceRules(
    db,
    memberSets.flatMap((members) =>
      members.flatMap(({ people }) =>
        people.sender ? [people.sender.address] : [],
      ),
    ),
  );
  const messages = results
    .slice(0, pageSize)
    .map(({ metadata: _metadata, sortAt, archived, ...row }, index) => {
      const members = memberSets[index]!.map((member) => ({
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
        ...(all ? {} : { receivedAt: sortAt }),
        subject: conversationSubject(members),
        lastMessageAt: lastMessage?.timestamp ?? sortAt,
        lastMessageId: lastMessage?.id ?? row.id,
        messageCount: members.length,
        participants: conversationPeople(members),
        senders: [...senders.values()],
        ...(avatarSender ? { avatarSender } : {}),
      };
    });
  const last = results[pageSize - 1];
  return {
    messages,
    cursor:
      last && results.length > pageSize ? `${last.sortAt}/${last.id}` : null,
  };
};

export const readThread = async (db: MailDatabase, id: string) => {
  const { results } = await db
    .prepare(
      `
    SELECT id, folder, sender AS "from", recipient AS "to", subject, timestamp, unread, people, archived,
           CASE WHEN m.folder = 'inbox' THEN ${indexedSender} END AS senderAddress,
           CASE WHEN m.folder = 'inbox' THEN (${senderPriority}) END AS senderPriority
    FROM mail_index_messages m
    WHERE mailbox_id = ${mailboxSql(db)} AND thread_id = (SELECT thread_id FROM mail_index_keys WHERE mailbox_id = ${mailboxSql(db)} AND identity = ?)
      AND deleted = 0
    ORDER BY timestamp, id
  `,
    )
    .bind(localIdentity(id))
    .all<
      Omit<ConversationMessage, "unread" | "people"> & {
        unread: number;
        archived: number;
        people: string | null;
        senderAddress: string | null;
        senderPriority: "signal" | "noise" | null;
      }
    >();
  const incoming = results.findLast(({ folder }) => folder === "inbox");
  const address = incoming?.senderAddress;
  return {
    archived: results.some(({ archived }) => archived === 1),
    ...(isPersonEmail(address)
      ? {
          senderRule: {
            address,
            priority: incoming?.senderPriority ?? "automatic",
          } satisfies typeof SenderRule.Type,
        }
      : {}),
    messages: await withSenderAppearances(
      db,
      results.map(
        ({
          unread,
          archived: _archived,
          senderAddress: _senderAddress,
          senderPriority: _senderPriority,
          ...message
        }) => ({
          ...withPeople(message),
          unread: unread === 1,
        }),
      ),
    ),
  };
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
) => {
  const scanId = folder === "inbox" ? "inbox:list-mail" : "sent:people";
  const state = await db
    .prepare(
      `SELECT cursor, scanned_at AS scannedAt, ready FROM mail_index_scans WHERE mailbox_id = ${mailboxSql(db)} AND folder = ?`,
    )
    .bind(scanId)
    .first<{ cursor: string | null; scannedAt: number; ready: number }>();
  if (state?.ready && !reconcile) return false;
  // A mailbox indexed by the older scan can be used while list headers backfill.
  const alreadyIndexed =
    folder === "inbox" && !state?.ready
      ? await db
          .prepare(
            `SELECT ready FROM mail_index_scans WHERE mailbox_id = ${mailboxSql(db)} AND folder = 'inbox:people'`,
          )
          .first<{ ready: number }>()
      : null;
  const page = await bucket.list({
    limit: scanSize,
    cursor: state?.cursor ?? undefined,
    include: ["customMetadata"],
  });
  if (page.objects.length) {
    const { results } = await db
      .prepare(
        `SELECT id FROM mail_index_messages
         WHERE mailbox_id = ${mailboxSql(db)} AND (deleted <> 0 OR (people IS NOT NULL AND (folder = 'sent' OR list_mail IS NOT NULL)))
           AND id IN (SELECT value FROM json_each(?))`,
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
          await Promise.all(
            indexed.map((mail) => indexMailStatements(db, mail)),
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
      page.truncated ? page.cursor : null,
      Date.now(),
      state?.ready || !page.truncated ? 1 : 0,
      state?.cursor ?? null,
      state?.scannedAt ?? -1,
    )
    .run();
  return page.truncated && !state?.ready && !alreadyIndexed?.ready;
};
