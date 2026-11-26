import type { R2Bucket, RateLimit, SendEmail } from "@cloudflare/workers-types";
import { Effect } from "effect";
import type { WorkerEnv } from "../../../../alchemy.run.ts";
import {
  splitRecipients,
  type InboxDraft,
  type ReplyCompletion,
} from "../inbox-contract.ts";
import { indexMail, setThreadArchived } from "./mail-index.ts";
import type { MailDatabase } from "./mailbox.ts";
import { describeSent, saveSent, type SentReply } from "./sent-mail.ts";

export type MailSenderBindings = {
  INBOX_EMAIL_FROM?: string | undefined;
  INBOX_SEND?: SendEmail;
  INBOX_SEND_LIMIT?: RateLimit;
};

type MailDeliveryStore = Pick<WorkerEnv, "INBOX_UPDATES"> & {
  DB: MailDatabase;
  SENT_MESSAGES: R2Bucket;
};

export const sendRateLimitMessage = "Sending limit reached. Try again later.";
export const uncertainDelivery = { status: "uncertain" } as const;
export const rejectedDelivery = (httpStatus: number, message: string) => ({
  status: "rejected" as const,
  httpStatus,
  message,
});

export const notifyInbox = async ({
  INBOX_UPDATES,
  DB,
}: Pick<WorkerEnv, "INBOX_UPDATES"> & { DB: MailDatabase }) => {
  if (!INBOX_UPDATES) return;
  try {
    await INBOX_UPDATES.getByName(DB.mailboxId).publish();
  } catch {
    console.warn("Could not notify Inbox subscribers");
  }
};

// R2 lists keys in ascending order, so new messages sort newest first.
const newestFirstKey = (date: number) => {
  const time = String(9_999_999_999_999 - date).padStart(13, "0");
  return `0-${time}-${crypto.randomUUID()}`;
};

export const inboxMessageKey = () => `${newestFirstKey(Date.now())}.eml`;

export const inboxSender = (env: MailSenderBindings) => {
  const {
    INBOX_EMAIL_FROM: from,
    INBOX_SEND: binding,
    INBOX_SEND_LIMIT: limit,
  } = env;
  return from && binding && limit ? { from, binding, limit } : null;
};

export const sendDraft = Effect.fnUntraced(function* (
  binding: SendEmail,
  env: MailDeliveryStore,
  defer: (work: Promise<unknown>) => void,
  message: typeof InboxDraft.Type & { from: string },
  reply: SentReply | undefined,
  completeThrough: string | undefined,
) {
  const { attachments, cc, ...body } = message;
  const sent = yield* Effect.tryPromise({
    try: () =>
      binding.send({
        ...body,
        to: message.to.includes(",") ? splitRecipients(message.to) : message.to,
        ...(cc ? { cc: splitRecipients(cc) } : {}),
        ...(attachments
          ? {
              attachments: attachments.map((file) => ({
                ...file,
                disposition: "attachment" as const,
                content: Uint8Array.fromBase64(file.content),
              })),
            }
          : {}),
        ...(reply?.headers ? { headers: reply.headers } : {}),
      }),
    catch: (error) =>
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined,
  }).pipe(Effect.result);
  if (sent._tag === "Success") {
    if (!sent.success?.messageId) return uncertainDelivery;
    const sentAt = Date.now();
    const record = {
      ...message,
      id: newestFirstKey(sentAt),
      sentAt,
      providerMessageId: sent.success.messageId,
      ...(reply ? { reply } : {}),
    };
    const saved = yield* saveSent(env.SENT_MESSAGES, record);
    if (saved)
      yield* Effect.promise(() =>
        indexMail(env.DB, describeSent(record)).catch(() => {
          console.warn("Could not index sent email");
        }),
      );
    let completion: typeof ReplyCompletion.Type | null = null;
    if (reply && completeThrough) {
      const result = yield* Effect.promise(() =>
        setThreadArchived(
          env.DB,
          completeThrough,
          true,
          reply.originalId,
        ).catch(() => {
          console.warn("Could not mark replied conversation done");
          return "missing" as const;
        }),
      );
      completion =
        result === "stale"
          ? "new-mail"
          : result === "missing"
            ? "failed"
            : "done";
    }
    if (saved || completion === "done") defer(notifyInbox(env));
    return {
      status: "sent" as const,
      messageId: saved ? record.id : null,
      completion,
    };
  }
  switch (sent.failure) {
    case "E_VALIDATION_ERROR":
      return rejectedDelivery(400, "Cloudflare rejected the email format.");
    case "E_RECIPIENT_SUPPRESSED":
      return rejectedDelivery(
        422,
        "Cloudflare has suppressed this recipient address.",
      );
    case "E_RECIPIENT_NOT_ALLOWED":
    case "E_RECIPIENT_PLAN_RESTRICTED":
      return rejectedDelivery(
        422,
        "Cloudflare does not allow sending to this address.",
      );
    case "E_DELIVERY_FAILED":
      return rejectedDelivery(
        422,
        "Cloudflare could not deliver the email to this address.",
      );
    case "E_RATE_LIMIT_EXCEEDED":
    case "E_DAILY_LIMIT_EXCEEDED":
      return rejectedDelivery(429, sendRateLimitMessage);
    default:
      return uncertainDelivery;
  }
}, Effect.withTracerEnabled(false));

export type MailDelivery = Effect.Success<ReturnType<typeof sendDraft>>;
