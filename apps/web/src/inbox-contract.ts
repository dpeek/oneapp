import { FileMetadata } from "@oneapp/core/files";
import { Schema as AuthSchema } from "@yielded/auth";
import { Schema } from "effect";
import { PersonMatch } from "./people-contract.ts";

export const inboxPath = "/inbox";
export const inboxApiPath = "/api/inbox";
export const inboxEventsPath = `${inboxApiPath}/events`;
export const conversationsApiPath = `${inboxApiPath}/conversations`;
export const archiveApiPath = `${inboxApiPath}/archive`;
export const allMailApiPath = `${inboxApiPath}/all`;
export const conversationApi = (id: string) => `${conversationsApiPath}/${id}`;
export const conversationArchiveApi = (id: string) =>
  `${conversationApi(id)}/archive`;
export const inboxSendPath = `${inboxApiPath}/send`;
export const inboxUnreadPath = `${inboxApiPath}/unread`;
export const sentCopyHeader = "x-oneapp-sent-copy";
export const sentPath = `${inboxPath}/sent`;
export const archivePath = `${inboxPath}/archive`;
export const allMailPath = `${inboxPath}/all`;
export const sentApiPath = `${inboxApiPath}/sent`;
export const inboxChanged = "inbox.changed";
export const MailFolder = Schema.Literals(["inbox", "sent"]);
export type MailFolder = typeof MailFolder.Type;
export const MailboxView = Schema.Literals(["inbox", "sent", "archive", "all"]);
export type MailboxView = typeof MailboxView.Type;
const mailboxPaths = {
  inbox: inboxPath,
  sent: sentPath,
  archive: archivePath,
  all: allMailPath,
};
export const folderPath = (folder: MailboxView) => mailboxPaths[folder];
export const folderApiPath = (folder: MailFolder) =>
  folder === "sent" ? sentApiPath : inboxApiPath;
export const mailMessagePage = (folder: MailboxView, id: string) =>
  `${folderPath(folder)}/${id}`;
export const mailMessageApi = (folder: MailFolder, id: string) =>
  `${folderApiPath(folder)}/${id}`;
export const inboxMessageApi = (id: string) => `${inboxApiPath}/${id}`;
export const inboxOriginalApi = (id: string) =>
  `${inboxMessageApi(id)}/original`;
export const inboxAttachmentApi = (id: string, part: number) =>
  `${inboxMessageApi(id)}/attachments/${part}`;
export const inboxAttachmentPreviewApi = (id: string, part: number) =>
  `${inboxAttachmentApi(id, part)}/preview`;
export const inboxAttachmentTextPreviewLimit = 32 * 1024;
export const inboxReadApi = (id: string) => `${inboxMessageApi(id)}/read`;
export const inboxReplyApi = (id: string) => `${inboxMessageApi(id)}/reply`;
export const InboxUnread = Schema.Struct({ unreadCount: Schema.Number });
export const InboxReadUpdate = Schema.Struct({ unread: Schema.Boolean });
export const ConversationArchiveUpdate = Schema.Struct({
  archived: Schema.Boolean,
});

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

export const MailPerson = Schema.Struct({
  address: Schema.String,
  name: Schema.String,
});
export type MailPerson = typeof MailPerson.Type;

export const InboxSummary = Schema.Struct({
  ...messageFields,
  id: InboxMessageId,
  receivedAt: Schema.Number,
  messageCount: Schema.optionalKey(Schema.Number),
  unreadCount: Schema.optionalKey(Schema.Number),
  lastMessageAt: Schema.optionalKey(Schema.Number),
  participants: Schema.optionalKey(Schema.Array(MailPerson)),
  profiles: Schema.optionalKey(Schema.Array(PersonMatch)),
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

export const ConversationSummary = Schema.Struct({
  ...messageFields,
  id: MailMessageId,
  latestIncomingId: Schema.NullOr(InboxMessageId),
  archived: Schema.Boolean,
  receivedAt: Schema.optionalKey(Schema.Number),
  lastMessageAt: Schema.Number,
  messageCount: Schema.Number,
  unreadCount: Schema.Number,
  participants: Schema.Array(MailPerson),
  profiles: Schema.Array(PersonMatch),
});

export const ConversationPage = Schema.Struct({
  ...pageFields,
  messages: Schema.Array(ConversationSummary),
});

export const MailPage = Schema.Struct({
  ...pageFields,
  messages: Schema.Array(Schema.Union([ConversationSummary, SentSummary])),
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

export const InlineReply = Schema.Struct({ text: InboxDraft.fields.text });

export const replySubject = (original: string) => {
  const subject = original.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
  const reply = /^re:/iu.test(subject) ? subject : `Re: ${subject}`;
  return reply
    .slice(0, inboxComposeLimits.subject)
    .replace(/[\uD800-\uDBFF]$/u, "")
    .trimEnd();
};

export const MailPeople = Schema.Struct({
  sender: Schema.NullOr(MailPerson),
  members: Schema.Array(MailPerson),
});
export type MailPeople = typeof MailPeople.Type;

export const AttachmentPart = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
export const InboxAttachment = Schema.Struct({
  ...FileMetadata.fields,
  part: AttachmentPart,
  preview: Schema.NullOr(Schema.Literals(["image", "pdf", "text"])),
});
export type InboxAttachment = typeof InboxAttachment.Type;

const previewFields = {
  text: Schema.String,
  people: Schema.optionalKey(MailPeople),
  preview: Schema.Literals(["complete", "truncated", "tooLarge", "unreadable"]),
};

export const InboxEntry = Schema.Struct({
  ...InboxSummary.fields,
  ...previewFields,
  to: Schema.String,
  unread: Schema.optionalKey(Schema.Boolean),
  attachments: Schema.optionalKey(Schema.Array(InboxAttachment)),
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
  unread: Schema.optionalKey(Schema.Boolean),
  people: Schema.optionalKey(MailPeople),
});
export type ConversationMessage = typeof ConversationMessage.Type;
export const Conversation = Schema.Struct({
  messages: Schema.Array(ConversationMessage),
  profiles: Schema.optionalKey(Schema.Array(PersonMatch)),
  archived: Schema.optionalKey(Schema.Boolean),
});
