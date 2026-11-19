import type { R2Bucket, R2Object, R2Objects } from "@cloudflare/workers-types";
import { Effect, Schedule, Schema } from "effect";
import { SentMessageId, SentSummary } from "../inbox-contract.ts";

const SentRecord = Schema.Struct({
  ...SentSummary.fields,
  text: Schema.String,
  providerMessageId: Schema.String,
});

type SentRecord = typeof SentRecord.Type;

const decodeSummary = Schema.decodeUnknownOption(SentSummary);
const decodeRecord = Schema.decodeUnknownOption(SentRecord);
export const isSentMessageId = Schema.is(SentMessageId);

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

export const readSent = async (bucket: R2Bucket, id: string) => {
  const object = await bucket.get(id);
  if (!object) return null;
  const record = decodeRecord(await object.json());
  if (record._tag === "None" || record.value.id !== id)
    throw new Error("Could not read stored sent message");
  const { from, to, subject, sentAt, text } = record.value;
  return { id, from, to, subject, sentAt, text, preview: "complete" as const };
};
