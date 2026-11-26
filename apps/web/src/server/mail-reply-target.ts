import type { R2Bucket } from "@cloudflare/workers-types";
import { mailMimeOptions } from "./mail-attachments.ts";
import { readHeaders } from "./mail-content.ts";
import {
  replyAllRecipients,
  replyHeaders,
  replyRecipient,
} from "./mail-reply.ts";
import { isSentMessageId, readSentReplyTarget } from "./sent-mail.ts";

type ReplyStore = { INBOX_MESSAGES: R2Bucket; SENT_MESSAGES: R2Bucket };

export const readReplyTarget = async (
  env: ReplyStore,
  id: string,
  ownAddresses: readonly string[] = [],
) => {
  if (isSentMessageId(id))
    return readSentReplyTarget(env.SENT_MESSAGES, id, ownAddresses);
  const original = await readHeaders(
    env.INBOX_MESSAGES,
    id,
    mailMimeOptions.maxHeadersSize,
  );
  if (!original) return null;
  const { email, metadata } = original;
  const envelopeFrom = metadata?.envelopeFrom ?? "";
  const own = [
    ...ownAddresses,
    ...(metadata?.envelopeTo ? [metadata.envelopeTo] : []),
  ];
  return {
    to: replyRecipient(email, envelopeFrom),
    ...replyAllRecipients(email, envelopeFrom, own),
    subject: email?.subject ?? metadata?.subject ?? "",
    headers: email ? replyHeaders(email) : undefined,
  };
};
