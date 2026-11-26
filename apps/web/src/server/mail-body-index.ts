import type { R2Bucket } from "@cloudflare/workers-types";
import type { MailFolder } from "../inbox-contract.ts";
import { receivedMessageLimit } from "./mail-attachments.ts";
import { readableMessage, readMailMime } from "./mail-content.ts";
import { mailboxSql, type MailDatabase } from "./mailbox.ts";
import { rawMailFormat } from "./raw-mail.ts";
import { readSentRecord } from "./sent-mail.ts";

type MailStore = {
  DB: MailDatabase;
  INBOX_MESSAGES: R2Bucket;
  SENT_MESSAGES: R2Bucket;
};

const batchSize = 8;
// The display text and normalized words share a row. Leave room for both
// UTF-8 encodings under D1's row limit.
const bodyLimit = 256 * 1024;
const excerptLimit = 240;
const wordPattern = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;
const normalizeWord = (word: string) => word.normalize("NFC").toLowerCase();

export const mailBodyWords = (text: string) =>
  Array.from(text.matchAll(wordPattern), ([word]) => normalizeWord(word));

export const searchableMailText = (
  body: Parameters<typeof readableMessage>[0] | null,
) => (body ? readableMessage(body, 1024 * 1024).text : "");

export const readStoredMailText = async (
  bucket: R2Bucket,
  folder: MailFolder,
  id: string,
) => {
  const object = await bucket.get(id);
  if (!object) return "";
  if (folder === "sent" && object.customMetadata?.format !== rawMailFormat) {
    if (object.size > receivedMessageLimit) {
      await object.body.cancel();
      return "";
    }
    return searchableMailText(
      (await readSentRecord(bucket, id, object)) ?? null,
    );
  }
  const mime = await readMailMime(object);
  return searchableMailText(mime.status === "complete" ? mime.email : null);
};

export const indexMailBodyStatements = (
  db: MailDatabase,
  id: string,
  text: string,
) => {
  const scope = mailboxSql(db);
  const readable = text.replace(/\s+/gu, " ").trim();
  const body = (
    readable.length > bodyLimit
      ? readable.slice(0, bodyLimit).replace(/\S+$/u, "")
      : readable
  ).toWellFormed();
  const words = mailBodyWords(body);
  const pending = `SELECT 1 FROM mail_index_messages
    WHERE mailbox_id = ${scope} AND id = ?1 AND deleted = 0 AND body_indexed = 0`;
  return [
    ...(words.length
      ? [
          db
            .prepare(
              `INSERT INTO mail_body_text (mailbox_id, message_id, body, words)
               SELECT ${scope}, ?1, ?2, ?3 WHERE EXISTS (${pending})`,
            )
            .bind(id, body, ` ${words.join(" ")} `),
          db
            .prepare(
              `INSERT INTO mail_body_terms (mailbox_id, term, message_id)
               SELECT ${scope}, value, ?1 FROM json_each(?2) WHERE EXISTS (${pending})`,
            )
            .bind(
              id,
              JSON.stringify([
                ...new Set(words.filter((word) => word.length <= 400)),
              ]),
            ),
        ]
      : []),
    db
      .prepare(
        `UPDATE mail_index_messages SET body_indexed = 1
         WHERE mailbox_id = ${scope} AND id = ?1 AND deleted = 0 AND body_indexed = 0`,
      )
      .bind(id),
  ];
};

export const mailBodyIndexPending = (db: MailDatabase) =>
  db
    .prepare(
      `SELECT 1 FROM mail_index_messages
       WHERE mailbox_id = ${mailboxSql(db)} AND deleted = 0 AND body_indexed = 0 LIMIT 1`,
    )
    .first();

export const backfillMailBodies = async ({
  DB,
  INBOX_MESSAGES,
  SENT_MESSAGES,
}: MailStore) => {
  const { results } = await DB.prepare(
    `SELECT id, folder FROM mail_index_messages
     WHERE mailbox_id = ${mailboxSql(DB)} AND deleted = 0 AND body_indexed = 0
     ORDER BY id LIMIT ?`,
  )
    .bind(batchSize)
    .all<{ id: string; folder: MailFolder }>();
  // Each commit is a checkpoint. A retry only reads rows still pending, and
  // concurrent writers recheck visibility and completion in the D1 batch.
  let failed = false;
  for (const { id, folder } of results) {
    try {
      const bucket = folder === "inbox" ? INBOX_MESSAGES : SENT_MESSAGES;
      const text = await readStoredMailText(bucket, folder, id);
      await DB.batch(indexMailBodyStatements(DB, id, text));
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error("Could not index some mail bodies");
};

export const mailBodyExcerpt = (body: string, phrase: readonly string[]) => {
  const recent: RegExpMatchArray[] = [];
  for (const match of body.matchAll(wordPattern)) {
    recent.push(match);
    if (recent.length > phrase.length) recent.shift();
    if (
      recent.length !== phrase.length ||
      !phrase.every((word, index) => word === normalizeWord(recent[index]![0]))
    )
      continue;
    const start = recent[0]!.index!;
    const end = match.index! + match[0].length;
    const context = Math.max(0, Math.min(64, excerptLimit - (end - start)));
    const left = Math.max(0, start - context);
    const right = left + excerptLimit;
    return (
      (left > 0 ? "…" : "") +
      body.slice(left, right).trim().toWellFormed() +
      (right < body.length ? "…" : "")
    );
  }
  return "";
};
