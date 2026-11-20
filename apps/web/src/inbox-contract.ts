import { FileMetadata } from "@oneapp/core/files";
import { Schema as AuthSchema } from "@yielded/auth";
import { Schema } from "effect";
import { PersonEmail, PersonMatch } from "./people-contract.ts";

export const mailPath = "/mail";
export const inboxApiPath = "/api/inbox";
export const inboxEventsPath = `${inboxApiPath}/events`;
export const conversationsApiPath = `${inboxApiPath}/conversations`;
export const archiveApiPath = `${inboxApiPath}/archive`;
export const allMailApiPath = `${inboxApiPath}/all`;
export const noiseApiPath = `${inboxApiPath}/noise`;
export const senderRuleApiPath = `${inboxApiPath}/sender-rule`;
export const conversationApi = (id: string) => `${conversationsApiPath}/${id}`;
export const conversationArchiveApi = (id: string) =>
  `${conversationApi(id)}/archive`;
export const inboxSendPath = `${inboxApiPath}/send`;
export const inboxUnreadPath = `${inboxApiPath}/unread`;
export const sentCopyHeader = "x-oneapp-sent-copy";
export const sentMessageHeader = "x-oneapp-sent-message";
export const replyCompletionHeader = "x-oneapp-reply-completion";
export const ReplyCompletion = Schema.Literals(["done", "new-mail", "failed"]);
export const sentPath = `${mailPath}/sent`;
export const archivePath = `${mailPath}/archive`;
export const allMailPath = `${mailPath}/all`;
export const noisePath = `${mailPath}/noise`;
export const sentApiPath = `${inboxApiPath}/sent`;
export const inboxChanged = "inbox.changed";
export const MailFolder = Schema.Literals(["inbox", "sent"]);
export type MailFolder = typeof MailFolder.Type;
export const MailboxView = Schema.Literals([
  "inbox",
  "noise",
  "sent",
  "archive",
  "all",
]);
export type MailboxView = typeof MailboxView.Type;
export const isInboxView = (view: MailboxView) =>
  view === "inbox" || view === "noise";
const mailboxPaths = {
  inbox: mailPath,
  noise: noisePath,
  sent: sentPath,
  archive: archivePath,
  all: allMailPath,
};
export const folderPath = (folder: MailboxView) => mailboxPaths[folder];
export const folderApiPath = (folder: MailFolder) =>
  folder === "sent" ? sentApiPath : inboxApiPath;
const inboxFileSuffix = ".eml";
const receivedRoutePrefix = "received/";
export const mailMessagePage = (folder: MailboxView, id: string) => {
  const received = id.endsWith(inboxFileSuffix);
  const prefix = folder === "all" && received ? receivedRoutePrefix : "";
  const segment = received ? id.slice(0, -inboxFileSuffix.length) : id;
  return `${folderPath(folder)}/${prefix}${segment}`;
};
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
export const SenderPriority = Schema.Literals(["automatic", "signal", "noise"]);
export const SenderRule = Schema.Struct({
  address: PersonEmail,
  priority: SenderPriority,
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

const isInboxMessageId = Schema.is(InboxMessageId);
const isSentMessageId = Schema.is(SentMessageId);
export const MailRoute = Schema.Struct({
  folder: MailboxView,
  id: Schema.NullOr(MailMessageId),
});

export const mailRouteFor = (
  pathname: string,
): typeof MailRoute.Type | null => {
  for (const folder of MailboxView.literals) {
    const root = folderPath(folder);
    if (pathname === root || pathname === `${root}/`)
      return { folder, id: null };
    if (!pathname.startsWith(`${root}/`)) continue;
    const segment = pathname.slice(root.length + 1);
    if ((folder === "sent" || folder === "all") && isSentMessageId(segment))
      return { folder, id: segment };
    if (folder === "sent") continue;

    let id = segment;
    if (folder === "all") {
      // Bare reverse-timestamp IDs in All mail already identify sent copies.
      if (segment.startsWith(receivedRoutePrefix))
        id = segment.slice(receivedRoutePrefix.length);
      else if (!segment.endsWith(inboxFileSuffix)) continue;
    }
    if (!id.endsWith(inboxFileSuffix)) id += inboxFileSuffix;
    if (isInboxMessageId(id)) return { folder, id };
  }
  return null;
};

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

const sentSummaryFields = {
  ...messageFields,
  id: SentMessageId,
  to: Schema.String,
  sentAt: Schema.Number,
};

export const SentSummary = Schema.Struct({
  ...sentSummaryFields,
  bodyPreview: Schema.optionalKey(Schema.String),
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
  bodyPreview: Schema.optionalKey(Schema.String),
  messageCount: Schema.Number,
  unreadCount: Schema.Number,
  participants: Schema.Array(MailPerson),
  senders: Schema.optionalKey(Schema.Array(MailPerson)),
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

export const InlineReply = Schema.Struct({
  text: InboxDraft.fields.text,
  completeThrough: Schema.optionalKey(InboxMessageId),
});

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
  ...sentSummaryFields,
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
  bodyPreview: Schema.optionalKey(Schema.String),
});
export type ConversationMessage = typeof ConversationMessage.Type;
export const Conversation = Schema.Struct({
  messages: Schema.Array(ConversationMessage),
  profiles: Schema.optionalKey(Schema.Array(PersonMatch)),
  archived: Schema.optionalKey(Schema.Boolean),
  senderRule: Schema.optionalKey(SenderRule),
});
