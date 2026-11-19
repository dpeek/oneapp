import { Schema as AuthSchema } from "@yielded/auth";
import { Schema } from "effect";

export const inboxPath = "/inbox";
export const inboxApiPath = "/api/inbox";
export const inboxEventsPath = `${inboxApiPath}/events`;
export const inboxSendPath = `${inboxApiPath}/send`;
export const inboxChanged = "inbox.changed";
export const inboxMessagePage = (id: string) => `${inboxPath}/${id}`;
export const inboxMessageApi = (id: string) => `${inboxApiPath}/${id}`;
export const inboxOriginalApi = (id: string) =>
  `${inboxMessageApi(id)}/original`;

// Accept both the current reverse-timestamp keys and the original ISO keys.
export const InboxMessageId = Schema.String.check(
  Schema.isPattern(
    /^(?:0-\d{13}|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\.eml$/u,
  ),
);

export const InboxSummary = Schema.Struct({
  id: InboxMessageId,
  from: Schema.String,
  subject: Schema.String,
  receivedAt: Schema.Number,
});

export const InboxPage = Schema.Struct({
  messages: Schema.Array(InboxSummary),
  cursor: Schema.NullOr(Schema.String),
  address: Schema.NullOr(Schema.String),
  sender: Schema.optional(Schema.String),
});

export const inboxComposeLimits = { to: 254, subject: 200, text: 32_768 };
const decodeMailbox = Schema.decodeUnknownOption(AuthSchema.Email);

export const InboxDraft = Schema.Struct({
  to: Schema.Trim.check(
    Schema.isMaxLength(inboxComposeLimits.to),
    Schema.makeFilter((value) => decodeMailbox(value)._tag === "Some"),
  ),
  subject: Schema.Trim.check(
    Schema.isMaxLength(inboxComposeLimits.subject),
    Schema.isPattern(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u),
  ),
  text: Schema.String.check(
    Schema.isMaxLength(inboxComposeLimits.text),
    Schema.makeFilter((value) => value.trim().length > 0),
  ),
});

export const InboxEntry = Schema.Struct({
  ...InboxSummary.fields,
  to: Schema.String,
  text: Schema.String,
  preview: Schema.Literals(["complete", "truncated", "tooLarge", "unreadable"]),
});
