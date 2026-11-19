import { Schema as AuthSchema } from "@yielded/auth";
import { Schema } from "effect";

export const inboxPath = "/inbox";
export const inboxApiPath = "/api/inbox";
export const inboxEventsPath = `${inboxApiPath}/events`;
export const conversationsApiPath = `${inboxApiPath}/conversations`;
export const conversationApi = (id: string) => `${conversationsApiPath}/${id}`;
export const inboxSendPath = `${inboxApiPath}/send`;
export const sentCopyHeader = "x-oneapp-sent-copy";
export const sentPath = `${inboxPath}/sent`;
export const sentApiPath = `${inboxApiPath}/sent`;
export const inboxChanged = "inbox.changed";
export const MailFolder = Schema.Literals(["inbox", "sent"]);
export type MailFolder = typeof MailFolder.Type;
export const folderPath = (folder: MailFolder) =>
  folder === "sent" ? sentPath : inboxPath;
export const folderApiPath = (folder: MailFolder) =>
  folder === "sent" ? sentApiPath : inboxApiPath;
export const mailMessagePage = (folder: MailFolder, id: string) =>
  `${folderPath(folder)}/${id}`;
export const mailMessageApi = (folder: MailFolder, id: string) =>
  `${folderApiPath(folder)}/${id}`;
export const inboxMessageApi = (id: string) => `${inboxApiPath}/${id}`;
export const inboxOriginalApi = (id: string) =>
  `${inboxMessageApi(id)}/original`;

// Accept both the current reverse-timestamp keys and the original ISO keys.
export const InboxMessageId = Schema.String.check(
  Schema.isPattern(
    /^(?:0-\d{13}|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\.eml$/u,
  ),
);

export const SentMessageId = Schema.String.check(
  Schema.isPattern(/^0-\d{13}-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u),
);
export const MailMessageId = Schema.Union([InboxMessageId, SentMessageId]);

const messageFields = {
  from: Schema.String,
  subject: Schema.String,
};

export const InboxSummary = Schema.Struct({
  ...messageFields,
  id: InboxMessageId,
  receivedAt: Schema.Number,
  messageCount: Schema.optionalKey(Schema.Number),
});

export const SentSummary = Schema.Struct({
  ...messageFields,
  id: SentMessageId,
  to: Schema.String,
  sentAt: Schema.Number,
});

const pageFields = {
  cursor: Schema.NullOr(Schema.String),
  address: Schema.NullOr(Schema.String),
  sender: Schema.optionalKey(Schema.String),
  indexing: Schema.optionalKey(Schema.Boolean),
};

export const InboxPage = Schema.Struct({
  ...pageFields,
  messages: Schema.Array(InboxSummary),
});

export const SentPage = Schema.Struct({
  ...pageFields,
  messages: Schema.Array(SentSummary),
});

export const MailPage = Schema.Struct({
  ...pageFields,
  messages: Schema.Array(Schema.Union([InboxSummary, SentSummary])),
});

export const inboxComposeLimits = { to: 254, subject: 200, text: 32_768 };
const decodeMailbox = Schema.decodeUnknownOption(AuthSchema.Email);

export const ComposeRecipient = Schema.Trim.check(
  Schema.isMaxLength(inboxComposeLimits.to),
  Schema.makeFilter((value) => decodeMailbox(value)._tag === "Some"),
);

export const InboxDraft = Schema.Struct({
  to: ComposeRecipient,
  subject: Schema.Trim.check(
    Schema.isMaxLength(inboxComposeLimits.subject),
    Schema.isPattern(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u),
  ),
  text: Schema.String.check(
    Schema.isMaxLength(inboxComposeLimits.text),
    Schema.makeFilter((value) => value.trim().length > 0),
  ),
});

export const InboxSend = Schema.Struct({
  ...InboxDraft.fields,
  replyToId: Schema.optionalKey(InboxMessageId),
});

const previewFields = {
  text: Schema.String,
  preview: Schema.Literals(["complete", "truncated", "tooLarge", "unreadable"]),
};

export const InboxEntry = Schema.Struct({
  ...InboxSummary.fields,
  ...previewFields,
  to: Schema.String,
  reply: Schema.optionalKey(
    Schema.Struct({
      to: Schema.String,
      threaded: Schema.Boolean,
    }),
  ),
});

export const SentEntry = Schema.Struct({
  ...SentSummary.fields,
  ...previewFields,
});
export const MailEntry = Schema.Union([InboxEntry, SentEntry]);

export const ConversationMessage = Schema.Struct({
  ...messageFields,
  id: MailMessageId,
  folder: MailFolder,
  to: Schema.String,
  timestamp: Schema.Number,
});
export type ConversationMessage = typeof ConversationMessage.Type;
export const Conversation = Schema.Struct({
  messages: Schema.Array(ConversationMessage),
});
