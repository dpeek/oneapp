import { Schema } from "effect";
import {
  ReplyCompletion,
  replyCompletionHeader,
  sentCopyHeader,
  sentMessageHeader,
  SentMessageId,
} from "./inbox-contract.ts";

const uncertainSend = "Could not confirm whether the email was sent.";
const decodeError = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.String }),
);

export const SentConfirmation = {
  saved: Schema.Boolean,
  sentId: Schema.NullOr(SentMessageId),
  completion: Schema.NullOr(ReplyCompletion),
};
const decodeSentId = Schema.decodeUnknownOption(SentMessageId);
const decodeCompletion = Schema.decodeUnknownOption(ReplyCompletion);

type SendResult =
  | { _tag: "SessionExpired" }
  | {
      _tag: "Sent";
      saved: boolean;
      sentId: string | null;
      completion: typeof ReplyCompletion.Type | null;
    }
  | { _tag: "Failed"; error: string };

export const sentNotice = (
  saved: boolean,
  completion: typeof ReplyCompletion.Type | null,
) =>
  [
    "Email sent.",
    ...(saved ? [] : ["Could not save a copy in Sent."]),
    ...(completion === "new-mail"
      ? ["New mail arrived. The conversation is still in Inbox."]
      : []),
    ...(completion === "failed"
      ? ["Could not mark the conversation done. You can mark it done manually."]
      : []),
  ].join(" ");

export const sendInboxRequest = async (
  path: string,
  message: object,
  signal: AbortSignal,
): Promise<SendResult> => {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-effect-auth-csrf": "1",
      },
      body: JSON.stringify(message),
      signal,
    });
    if (response.status === 401) return { _tag: "SessionExpired" };
    if (response.status === 204) {
      const sentId = decodeSentId(response.headers.get(sentMessageHeader));
      const completion = decodeCompletion(
        response.headers.get(replyCompletionHeader),
      );
      return {
        _tag: "Sent",
        saved: response.headers.get(sentCopyHeader) !== "failed",
        sentId: sentId._tag === "Some" ? sentId.value : null,
        completion: completion._tag === "Some" ? completion.value : null,
      };
    }
    const result = decodeError(await response.json());
    if (result._tag === "Some")
      return { _tag: "Failed", error: result.value.error };
  } catch {
    return { _tag: "Failed", error: uncertainSend };
  }
  return { _tag: "Failed", error: uncertainSend };
};
