import { Schema } from "effect";
import { sentCopyHeader } from "./inbox-contract.ts";

const uncertainSend = "Could not confirm whether the email was sent.";
const decodeError = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.String }),
);

type SendResult =
  | { _tag: "SessionExpired" }
  | { _tag: "Sent"; saved: boolean }
  | { _tag: "Failed"; error: string };

export const sentNotice = (saved: boolean) =>
  saved ? "Email sent." : "Email sent. Could not save a copy in Sent.";

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
    if (response.status === 204)
      return {
        _tag: "Sent",
        saved: response.headers.get(sentCopyHeader) !== "failed",
      };
    const result = decodeError(await response.json());
    if (result._tag === "Some")
      return { _tag: "Failed", error: result.value.error };
  } catch {
    return { _tag: "Failed", error: uncertainSend };
  }
  return { _tag: "Failed", error: uncertainSend };
};
