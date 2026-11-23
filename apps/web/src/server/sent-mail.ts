import type { R2Bucket, R2Object, R2Objects } from "@cloudflare/workers-types";
import { Effect, Schedule, Schema } from "effect";
import {
  buildReplyHeaders,
  conversationMessageIds,
  outboundMessageId,
} from "./mail-reply.ts";
import type { IndexedMail } from "./mail-index.ts";
import { mailPeople } from "./mail-people.ts";
import { sanitizeMailHtml } from "./mail-html.ts";
import {
  MailMessageId,
  SentMessageId,
  SentSummary,
} from "../inbox-contract.ts";

const SentReply = Schema.Struct({
  originalId: MailMessageId,
  headers: Schema.optionalKey(
    Schema.Struct({
      "In-Reply-To": Schema.optionalKey(Schema.String),
      References: Schema.String,
    }),
  ),
});
export type SentReply = typeof SentReply.Type;

const SentRecord = Schema.Struct({
  html: Schema.optionalKey(Schema.String),
  ...SentSummary.fields,
  text: Schema.String,
  providerMessageId: Schema.String,
  reply: Schema.optionalKey(SentReply),
});

type SentRecord = typeof SentRecord.Type;

const decodeSummary = Schema.decodeUnknownOption(SentSummary);
const decodeRecord = Schema.decodeUnknownOption(SentRecord);
export const isSentMessageId = Schema.is(SentMessageId);

const sentThreadHeaders = ({ providerMessageId, reply }: SentRecord) => ({
  "message-id": outboundMessageId(providerMessageId),
  references: reply?.headers?.References,
  "in-reply-to": reply?.headers?.["In-Reply-To"],
});

export const describeSent = (record: SentRecord): IndexedMail => {
  const { id, from, to, subject, sentAt, reply } = record;
  const headers = sentThreadHeaders(record);
  return {
    id,
    from,
    to,
    subject,
    folder: "sent",
    timestamp: sentAt,
    people: mailPeople(() => undefined, from, to),
    ...(reply ? { originalId: reply.originalId } : {}),
    messageIds: conversationMessageIds((name) => headers[name]),
  };
};

const summaryFor = ({ key, customMetadata }: R2Object) =>
  decodeSummary({
    ...customMetadata,
    id: key,
    sentAt: Number(customMetadata?.sentAt),
  });

export const saveSent = (bucket: R2Bucket, message: SentRecord) => {
  const { id, from, to, subject, sentAt } = message;
  return Effect.tryPromise(() =>
    bucket.put(id, JSON.stringify(message), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { from, to, subject, sentAt: String(sentAt) },
    }),
  ).pipe(
    Effect.retry({ times: 2, schedule: Schedule.spaced("100 millis") }),
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
};

export const listSent = async (
  bucket: R2Bucket,
  cursor: string | undefined,
) => {
  const page: R2Objects = await bucket.list({
    limit: 20,
    cursor,
    include: ["customMetadata"],
  });
  return {
    messages: page.objects.flatMap((object) => {
      const summary = summaryFor(object);
      return summary._tag === "Some" ? [summary.value] : [];
    }),
    cursor: page.truncated ? page.cursor : null,
  };
};

const readSentRecord = async (bucket: R2Bucket, id: string) => {
  const object = await bucket.get(id);
  if (!object) return null;
  const raw = await object.json().catch((error: unknown) => {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  });
  const record = decodeRecord(raw);
  return record._tag === "Some" && record.value.id === id
    ? record.value
    : undefined;
};

export const describeStoredSent = async (
  bucket: R2Bucket,
  object: R2Object,
) => {
  if (!isSentMessageId(object.key)) return null;
  const record = await readSentRecord(bucket, object.key);
  return record ? describeSent(record) : null;
};

export const readSent = async (bucket: R2Bucket, id: string) => {
  const record = await readSentRecord(bucket, id);
  if (record === undefined)
    throw new Error("Could not read stored sent message");
  if (!record) return null;
  const { from, to, subject, sentAt, text } = record;
  return {
    id,
    from,
    to,
    subject,
    sentAt,
    text,
    ...(record.html !== undefined
      ? { html: sanitizeMailHtml(record.html, []) }
      : {}),
    preview: "complete" as const,
    people: mailPeople(() => undefined, from, to),
  };
};

export const readSentReplyTarget = async (bucket: R2Bucket, id: string) => {
  const record = await readSentRecord(bucket, id);
  if (!record) return null;
  const headers = sentThreadHeaders(record);
  return {
    to: record.to,
    subject: record.subject,
    headers: buildReplyHeaders((name) => headers[name]),
  };
};
