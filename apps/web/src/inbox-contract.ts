import { Schema } from "effect";

export const inboxPath = "/inbox";
export const inboxApiPath = "/api/inbox";
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
});

export const InboxEntry = Schema.Struct({
  ...InboxSummary.fields,
  to: Schema.String,
  text: Schema.String,
  preview: Schema.Literals(["complete", "truncated", "tooLarge", "unreadable"]),
});
