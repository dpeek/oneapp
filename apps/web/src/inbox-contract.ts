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
export const trashApiPath = `${inboxApiPath}/trash`;
export const trashBatchApiPath = `${trashApiPath}/batches`;
export const trashBatchRestoreApi = (batchId: string) =>
  `${trashBatchApiPath}/${batchId}/restore`;
export const noiseApiPath = `${inboxApiPath}/noise`;
export const noiseSendersApiPath = `${inboxApiPath}/noise-senders`;
export const NoiseSenders = Schema.Struct({
  addresses: Schema.Array(PersonEmail),
});
export const senderAppearanceApiPath = `${inboxApiPath}/sender-appearance`;
export const SenderAppearanceMode = Schema.Literals([
  "auto",
  "person",
  "service",
]);
export const SenderAppearanceUpdate = Schema.Struct({
  address: PersonEmail,
  mode: SenderAppearanceMode,
});
export const MailAvatar = Schema.Struct({
  kind: Schema.Literals(["person", "service"]),
  mode: SenderAppearanceMode,
  domain: Schema.NullOr(Schema.String),
});
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
export const trashPath = `${mailPath}/trash`;
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
  "trash",
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
  trash: trashPath,
};
export const folderPath = (folder: MailboxView) => mailboxPaths[folder];
export const folderApiPath = (folder: MailFolder) =>
  folder === "sent" ? sentApiPath : inboxApiPath;
const inboxFileSuffix = ".eml";
const receivedRoutePrefix = "received/";
export const mailMessagePage = (folder: MailboxView, id: string) => {
  const received = id.endsWith(inboxFileSuffix);
  const prefix =
    (folder === "all" || folder === "trash") && received
      ? receivedRoutePrefix
      : "";
  const segment = received ? id.slice(0, -inboxFileSuffix.length) : id;
  return `${folderPath(folder)}/${prefix}${segment}`;
};
export const mailMessageApi = (folder: MailFolder, id: string) =>
  `${folderApiPath(folder)}/${id}`;
export const inboxMessageApi = (id: string) => `${inboxApiPath}/${id}`;
export const inboxOriginalApi = (id: string) =>
  `${inboxMessageApi(id)}/original`;
export const inboxAttachmentApi = (id: string, part: number, trash = false) =>
  `${inboxMessageApi(id)}/attachments/${part}${trash ? "?trash=1" : ""}`;
export const inboxAttachmentPreviewApi = (
  id: string,
  part: number,
  trash = false,
) =>
  `${inboxMessageApi(id)}/attachments/${part}/preview${trash ? "?trash=1" : ""}`;
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
export const TrashBatchId = Schema.String.check(Schema.isUUID(4));
export const TrashBatchMembers = Schema.Struct({
  ids: Schema.Array(MailMessageId),
});
export const TrashedConversation = Schema.Struct({
  ...TrashBatchMembers.fields,
  batchId: TrashBatchId,
});

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
    if (
      (folder === "sent" || folder === "all" || folder === "trash") &&
      isSentMessageId(segment)
    )
      return { folder, id: segment };
    if (folder === "sent") continue;

    let id = segment;
    if (folder === "all" || folder === "trash") {
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
  appearance: Schema.optionalKey(MailAvatar),
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
  deletedAt: Schema.optionalKey(Schema.Number),
  latestIncomingId: Schema.NullOr(InboxMessageId),
  archived: Schema.Boolean,
  receivedAt: Schema.optionalKey(Schema.Number),
  lastMessageAt: Schema.Number,
  bodyPreview: Schema.optionalKey(Schema.String),
  messageCount: Schema.Number,
  unreadCount: Schema.Number,
  participants: Schema.Array(MailPerson),
  senders: Schema.optionalKey(Schema.Array(MailPerson)),
  avatarSender: Schema.optionalKey(MailPerson),
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

export const inboxComposeLimits = {
  to: 5_120,
  subject: 200,
  text: 32_768,
  html: 131_072,
};
const decodeMailbox = Schema.decodeUnknownOption(AuthSchema.Email);

export const ComposeRecipient = Schema.Trim.check(
  Schema.isMaxLength(254),
  Schema.makeFilter((value) => decodeMailbox(value)._tag === "Some"),
);

export const splitRecipients = (value: string) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
const validRecipient = Schema.is(ComposeRecipient);
export const ComposeRecipients = Schema.Trim.check(
  Schema.isMaxLength(inboxComposeLimits.to),
  Schema.makeFilter((value) => {
    const recipients = value.split(",").map((part) => part.trim());
    return recipients.length <= 20 && recipients.every(validRecipient);
  }),
);
export const outgoingAttachmentLimit = 10 * 1024 * 1024;
export const OutgoingAttachment = Schema.Struct({
  filename: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(240),
    Schema.isPattern(/^[^/\\\p{Cc}\p{Zl}\p{Zp}]+$/u),
  ),
  type: Schema.String.check(
    Schema.isPattern(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/u),
  ),
  content: Schema.String.check(
    Schema.isMaxLength(4 * Math.ceil(outgoingAttachmentLimit / 3)),
    Schema.isPattern(
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
    ),
  ),
});
export const attachmentBytes = (content: string) =>
  (content.length / 4) * 3 -
  (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0);
export const OutgoingAttachments = Schema.Array(OutgoingAttachment).check(
  Schema.isMaxLength(20),
  Schema.makeFilter(
    (files) =>
      files.reduce((sum, file) => sum + attachmentBytes(file.content), 0) <=
      outgoingAttachmentLimit,
  ),
);

export const InboxDraft = Schema.Struct({
  html: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(inboxComposeLimits.html)),
  ),
  to: ComposeRecipients,
  cc: Schema.optionalKey(Schema.Union([ComposeRecipients, Schema.Literal("")])),
  attachments: Schema.optionalKey(OutgoingAttachments),
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
  html: InboxDraft.fields.html,
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

export const MailRemoteImages = Schema.Struct({
  available: Schema.Number,
  blocked: Schema.Number,
  loaded: Schema.Number,
  unavailable: Schema.Number,
});

const previewFields = {
  remoteImages: Schema.optionalKey(MailRemoteImages),
  text: Schema.String,
  people: Schema.optionalKey(MailPeople),
  preview: Schema.Literals(["complete", "truncated", "tooLarge", "unreadable"]),
};

export const InboxEntry = Schema.Struct({
  html: Schema.optionalKey(Schema.String),
  ...InboxSummary.fields,
  ...previewFields,
  to: Schema.String,
  unread: Schema.optionalKey(Schema.Boolean),
  attachments: Schema.optionalKey(Schema.Array(InboxAttachment)),
  reply: Schema.optionalKey(
    Schema.Struct({
      to: Schema.String,
      allTo: Schema.optionalKey(Schema.String),
      cc: Schema.optionalKey(Schema.String),
      threaded: Schema.Boolean,
    }),
  ),
});

export const SentEntry = Schema.Struct({
  html: Schema.optionalKey(Schema.String),
  ...sentSummaryFields,
  ...previewFields,
  cc: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(Schema.Array(InboxAttachment)),
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

export const DeletedMailCursor = Schema.Struct({
  deletedAt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  id: MailMessageId,
});
export const DeletedMail = Schema.Struct({
  ...DeletedMailCursor.fields,
  from: Schema.String,
  subject: Schema.String,
});
export const DeletedMailPage = Schema.Struct({
  messages: Schema.Array(DeletedMail),
  cursor: Schema.NullOr(Schema.String),
});
