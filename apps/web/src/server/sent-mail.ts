import type {
  R2Bucket,
  R2Object,
  R2ObjectBody,
  R2Objects,
} from "@cloudflare/workers-types";
import { Effect, Schedule, Schema } from "effect";
import { convert } from "html-to-text";
import {
  describeOutgoingAttachments,
  describeAttachments,
  mailMimeOptions,
  receivedMessageLimit,
} from "./mail-attachments.ts";
import { readMailMime } from "./mail-content.ts";
import {
  describeRawMail,
  describeStoredRawMail,
  parseRawHeaders,
  rawMailFormat,
} from "./raw-mail.ts";
import {
  buildReplyHeaders,
  conversationMessageIds,
  outboundMessageId,
} from "./mail-reply.ts";
import type { IndexedMail } from "./mail-index.ts";
import { mailPeople } from "./mail-people.ts";
import { mailHtmlPreview, type MailImageOptions } from "./mail-html-preview.ts";
import {
  MailMessageId,
  OutgoingAttachments,
  SentMessageId,
  SentSummary,
  type SentEntry,
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
  cc: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(OutgoingAttachments),
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
    people: mailPeople(
      (name) => (name === "cc" ? record.cc : undefined),
      from,
      to,
    ),
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
    messages: (
      await Promise.all(
        page.objects.map(async (object) => {
          if (object.customMetadata?.format === rawMailFormat) {
            const mail = await describeStoredRawMail(bucket, object, "sent");
            return mail
              ? [
                  {
                    id: mail.id,
                    from: mail.from,
                    to: mail.to,
                    subject: mail.subject,
                    sentAt: mail.timestamp,
                  },
                ]
              : [];
          }
          const summary = summaryFor(object);
          return summary._tag === "Some" ? [summary.value] : [];
        }),
      )
    ).flat(),
    cursor: page.truncated ? page.cursor : null,
  };
};

export const readSentRecord = async (
  bucket: R2Bucket,
  id: string,
  stored?: R2ObjectBody,
) => {
  const object = stored ?? (await bucket.get(id));
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
  if (object.customMetadata?.format === rawMailFormat)
    return describeStoredRawMail(bucket, object, "sent");
  const record = await readSentRecord(bucket, object.key);
  return record ? describeSent(record) : null;
};

export const readSent = async (
  bucket: R2Bucket,
  id: string,
  images?: MailImageOptions,
): Promise<typeof SentEntry.Type | null> => {
  const object = await bucket.get(id);
  if (!object) return null;
  if (object.customMetadata?.format === rawMailFormat) {
    const tooLarge = object.size > receivedMessageLimit;
    if (tooLarge) await object.body.cancel();
    const mail = await describeStoredRawMail(bucket, object, "sent");
    if (!mail) {
      if (!tooLarge) await object.body.cancel();
      return null;
    }
    const summary = {
      id,
      from: mail.from,
      to: mail.to,
      subject: mail.subject,
      sentAt: mail.timestamp,
      people: mail.people,
    };
    if (tooLarge) return { ...summary, text: "", preview: "tooLarge" };
    const mime = await readMailMime(object);
    if (mime.status !== "complete")
      return { ...summary, text: "", preview: mime.status };
    const { email } = mime;
    const limit = 128 * 1024;
    const html = email.text?.trim() ? "" : (email.html ?? "");
    const text = html ? convert(html.slice(0, limit)) : (email.text ?? "");
    return {
      ...summary,
      text: text.slice(0, limit),
      attachments: describeAttachments(email.attachments),
      ...(email.html && email.html.length <= 1024 * 1024
        ? await mailHtmlPreview(email.html, email.attachments, images)
        : {}),
      preview:
        text.length > limit || html.length > limit ? "truncated" : "complete",
    };
  }
  const record = await readSentRecord(bucket, id, object);
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
    ...(record.cc ? { cc: record.cc } : {}),
    ...(record.attachments?.length
      ? { attachments: describeOutgoingAttachments(record.attachments) }
      : {}),
    ...(record.html !== undefined
      ? await mailHtmlPreview(record.html, [], images)
      : {}),
    preview: "complete" as const,
    people: mailPeople(
      (name) => (name === "cc" ? record.cc : undefined),
      from,
      to,
    ),
  };
};

export const readSentReplyTarget = async (bucket: R2Bucket, id: string) => {
  const object = await bucket.get(id);
  if (!object) return null;
  if (object.customMetadata?.format === rawMailFormat) {
    await object.body.cancel();
    const header = await bucket.get(id, {
      range: {
        offset: 0,
        length: Math.min(object.size, mailMimeOptions.maxHeadersSize),
      },
    });
    if (!header) return null;
    const email = await parseRawHeaders(
      new Uint8Array(await header.arrayBuffer()),
    );
    const mail = describeRawMail(object, email, "sent");
    return {
      to: mail.to,
      subject: mail.subject,
      headers: buildReplyHeaders(
        (name) => email.headers.find(({ key }) => key === name)?.value,
      ),
    };
  }
  const record = await readSentRecord(bucket, id, object);
  if (!record) return null;
  const headers = sentThreadHeaders(record);
  return {
    to: record.to,
    subject: record.subject,
    headers: buildReplyHeaders((name) => headers[name]),
  };
};
