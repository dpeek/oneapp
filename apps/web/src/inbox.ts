import {
  defaultMailboxId,
  mailboxUrl,
  mailSettingsPath,
  type Mailbox,
} from "./mail-settings-contract.ts";
import {
  mailFetch,
  selectedMailbox,
  selectedMailboxUrl,
} from "./mailbox-client.ts";
import {
  alert,
  avatarGroup,
  backIcon,
  button,
  buttonClassName,
  Dialog,
  DropdownMenu,
  ellipsisIcon,
  item,
  ItemActionMenu,
  itemDisclosure,
  itemGroup,
  marker,
  navigationLinks,
  noiseIconPath,
  outlineIcon,
  Sheet,
  Popover,
  spinner,
  timestamp,
  trashIconPaths,
} from "@orumai/ui";
import { Effect, Option, Queue, Schema, Stream } from "effect";
import { Command, Render, Submodel, Update } from "foldkit";
import { focus } from "foldkit/dom";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
import * as Attachments from "./inbox-attachments.ts";
import * as Filters from "./inbox-filters.ts";
import { mailHtmlDocument, mailHtmlSandbox } from "./inbox-html.ts";
import * as Recovery from "./inbox-recovery.ts";
import * as Compose from "./inbox-compose.ts";
import * as QuickReply from "./inbox-inline-reply.ts";
import { dialogId as personDialogId } from "./people.ts";
import { Action, Notification } from "./notifications.ts";
import { sentNotice } from "./inbox-send.ts";
import {
  collapsibleMiddleCount,
  conversationPeople,
  conversationSubject,
  formatMailTimestamp,
  splitMailQuote,
} from "./inbox-display.ts";
import {
  allMailApiPath,
  archiveApiPath,
  Conversation,
  type ConversationMessage,
  conversationApi,
  conversationArchiveApi,
  ConversationPage,
  type ConversationSummary,
  conversationsApiPath,
  folderPath,
  inboxComposeLimits,
  InboxEntry,
  MailRemoteImages,
  InboxMessageId,
  inboxOriginalApi,
  inboxReadApi,
  InboxReadStatus,
  InboxUnread,
  inboxUnreadPath,
  isInboxView,
  mailFilterCount,
  MailEntry,
  MailFolder,
  MailFilters,
  MailboxView,
  MailMessageId,
  MailPage,
  MailRoute,
  type MailPerson,
  mailMessageApi,
  mailMessagePage,
  mailPath,
  noiseApiPath,
  trashApiPath,
  TrashedConversation,
  replySubject,
  SentEntry,
  sentApiPath,
  SentMessageId,
  SentPage,
  SenderPriority,
  SenderRule,
  senderRuleApiPath,
  supportsMailFilters,
} from "./inbox-contract.ts";
import {
  normalizePersonEmail,
  PersonEmail,
  type PersonMatch,
  type PersonSummary,
} from "./people-contract.ts";
import { mailAvatar } from "./mail-avatar.ts";
import {
  readWorkspaceLayout,
  screenHeader,
  watchWorkspaceWidth,
  workspace,
  workspaceDrawerMedia,
  WorkspaceLayout,
  workspaceLayoutButton,
} from "./workspace.ts";

const MessageLocation = Schema.Struct({
  folder: MailFolder,
  id: MailMessageId,
});

const isSentMessageId = Schema.is(SentMessageId);
const isPersonEmail = Schema.is(PersonEmail);
const mailboxLabels = {
  inbox: "Inbox",
  noise: "Inbox",
  sent: "Sent",
  all: "All mail",
  archive: "Archive",
  trash: "Trash",
} satisfies Record<MailboxView, string>;
const mailboxApiPaths = {
  inbox: conversationsApiPath,
  noise: noiseApiPath,
  sent: sentApiPath,
  all: allMailApiPath,
  archive: archiveApiPath,
  trash: trashApiPath,
};

const ArchiveChange = Schema.Struct({
  id: InboxMessageId,
  archived: Schema.Boolean,
});

const ArchiveRequest = Schema.Struct({
  ...ArchiveChange.fields,
  subject: Schema.optional(Schema.String),
  request: Schema.String,
  folder: MailboxView,
  selected: Schema.NullOr(MailMessageId),
});

const SenderRuleRequest = Schema.Struct({
  ...SenderRule.fields,
  request: Schema.String,
});

const messageFolder = (id: string): MailFolder =>
  isSentMessageId(id) ? "sent" : "inbox";

type ConversationAction = "archive" | typeof SenderPriority.Type;
type RowAction = ConversationAction | "toggleUnread" | "delete" | "restore";
type MessageAction =
  | "toggleUnread"
  | "download"
  | "restore"
  | "loadBlockedImages"
  | "retryImages"
  | "togglePlainText";
const conversationMenu = DropdownMenu.create<ConversationAction>();
const messageMenu = DropdownMenu.create<MessageAction>();
const rowMenu = ItemActionMenu.create<RowAction>();
const rowActions = ItemActionMenu.init("mail-row-actions");
const emptyTrashDialogId = "mail-empty-trash";
const splitViewKey = "orumai.mail.splitView";

const LiveChange = Schema.Struct({
  version: Schema.NullOr(Schema.Number),
  refreshView: Schema.Boolean,
});

export const Model = Schema.Struct({
  folder: MailboxView,
  layout: WorkspaceLayout,
  filters: Filters.Model,
  folderSheet: Sheet.Model,
  conversationMenu: DropdownMenu.Model,
  messageMenu: DropdownMenu.Model,
  rowActions: ItemActionMenu.Model,
  list: Schema.NullOr(MailPage),
  listRequest: Schema.NullOr(
    Schema.Struct({ id: Schema.String, cursor: Schema.NullOr(Schema.String) }),
  ),
  listRefreshQueued: Schema.Boolean,
  listError: Schema.NullOr(
    Schema.Struct({
      message: Schema.String,
      cursor: Schema.NullOr(Schema.String),
    }),
  ),
  sender: Schema.NullOr(Schema.String),
  unreadCount: Schema.Number,
  unreadRequest: Schema.NullOr(Schema.String),
  unreadRefreshQueued: Schema.Boolean,
  liveVersion: Schema.Number,
  localReadVersions: Schema.Array(Schema.Number),
  liveChangeQueued: Schema.NullOr(LiveChange),
  readRequests: Schema.Record(
    Schema.String,
    Schema.Struct({
      request: Schema.String,
      userInitiated: Schema.Boolean,
      unread: Schema.Boolean,
      previousUnread: Schema.Boolean,
      countsInInbox: Schema.Boolean,
      latestIncomingId: Schema.NullOr(InboxMessageId),
      subject: Schema.optional(Schema.String),
    }),
  ),
  readFailed: Schema.NullOr(InboxMessageId),
  selected: Schema.NullOr(MailMessageId),
  focusMessage: Schema.Boolean,
  middleRevealed: Schema.Boolean,
  active: Schema.NullOr(MessageLocation),
  thread: Schema.NullOr(Conversation),
  threadRequest: Schema.NullOr(Schema.String),
  threadRefreshQueued: Schema.Boolean,
  threadFailed: Schema.Boolean,
  entry: Schema.NullOr(MailEntry),
  entryRequest: Schema.NullOr(Schema.String),
  entryError: Schema.NullOr(Schema.String),
  imageRequest: Schema.NullOr(Schema.String),
  imageError: Schema.Boolean,
  showPlainText: Schema.Boolean,
  attachmentPreview: Attachments.Model,
  attachmentPopover: Popover.Model,
  deleteRequest: Schema.NullOr(
    Schema.Struct({
      id: MailMessageId,
      subject: Schema.optional(Schema.String),
      request: Schema.String,
      folder: MailFolder,
      conversationView: Schema.optionalKey(MailboxView),
    }),
  ),
  emptyTrashDialog: Dialog.Model,
  emptyTrashRequest: Schema.NullOr(Schema.String),
  emptyTrashError: Schema.NullOr(Schema.String),
  archiveRequest: Schema.NullOr(ArchiveRequest),
  senderRuleRequest: Schema.NullOr(SenderRuleRequest),
  compose: Compose.Model,
  recovery: Recovery.Model,
  quickReply: QuickReply.Model,
});
type Model = typeof Model.Type;

export const initial: Model = {
  folder: "inbox",
  layout: { wide: false, split: false },
  filters: Filters.initial,
  folderSheet: Sheet.init({ id: "mail-folders" }),
  conversationMenu: DropdownMenu.init({ id: "mail-conversation-actions" }),
  messageMenu: DropdownMenu.init({ id: "mail-message-actions" }),
  rowActions,
  list: null,
  listRequest: null,
  listRefreshQueued: false,
  listError: null,
  sender: null,
  unreadCount: 0,
  unreadRequest: null,
  unreadRefreshQueued: false,
  liveVersion: -1,
  localReadVersions: [],
  liveChangeQueued: null,
  readRequests: {},
  readFailed: null,
  selected: null,
  focusMessage: false,
  middleRevealed: false,
  active: null,
  thread: null,
  threadRequest: null,
  threadRefreshQueued: false,
  threadFailed: false,
  entry: null,
  entryRequest: null,
  entryError: null,
  imageRequest: null,
  imageError: false,
  showPlainText: false,
  attachmentPreview: Attachments.initial,
  attachmentPopover: Popover.init({ id: "mail-attachments" }),
  deleteRequest: null,
  emptyTrashDialog: Dialog.init({ id: emptyTrashDialogId }),
  emptyTrashRequest: null,
  emptyTrashError: null,
  archiveRequest: null,
  senderRuleRequest: null,
  compose: Compose.initial,
  recovery: Recovery.initial,
  quickReply: QuickReply.initial,
};

export const init = (): Model => ({
  ...initial,
  layout: readWorkspaceLayout(splitViewKey),
});

const isSplitView = ({ layout }: Model) => layout.wide && layout.split;
const isListVisible = (model: Model) =>
  model.selected === null || isSplitView(model);

export const Message = defineMessageUnion({
  Opened: { ...MailRoute.fields, refresh: Schema.optionalKey(Schema.Boolean) },
  ChangedLayoutWidth: { wide: Schema.Boolean },
  ToggledSplitView: {},
  FinishedSavingSplitView: {},
  GotFolderSheetMessage: { message: Sheet.Message },
  GotFiltersMessage: { message: Filters.Message },
  RetriedList: {},
  RefreshedUnread: {},
  GotRecoveryMessage: { message: Recovery.Message },
  OpenedCompose: {},
  GotComposeMessage: { message: Compose.Message },
  GotQuickReplyMessage: { message: QuickReply.Message },
  GotAttachmentMessage: { message: Attachments.Message },
  GotAttachmentPopoverMessage: { message: Popover.Message },
  LiveChanged: LiveChange.fields,
  RequestedMore: { folder: MailboxView, cursor: Schema.String },
  RetriedEntry: {},
  RetriedThread: {},
  UpdatedProfiles: {},
  ToggledMessage: MessageLocation.fields,
  RevealedMiddle: { firstMessageId: MailMessageId },
  RequestedBack: {},
  RequestedPerson: {
    address: Schema.String,
    name: Schema.String,
    suggestedCompany: Schema.optionalKey(Schema.Boolean),
    suggestedDomain: Schema.optionalKey(Schema.String),
    canLinkSender: Schema.optionalKey(Schema.Boolean),
  },
  RequestedReply: {},
  RequestedReplyAll: {},
  RequestedForward: {},
  DownloadStarted: {},
  RequestedMessageDelete: { id: MailMessageId },
  DeletedEntry: {
    id: MailMessageId,
    request: Schema.String,
    conversation: Schema.optionalKey(TrashedConversation),
  },
  DeleteFailed: { request: Schema.String },
  GotEmptyTrashDialogMessage: { message: Dialog.Message },
  ConfirmedEmptyTrash: {},
  EmptiedTrash: { request: Schema.String },
  EmptyTrashFailed: { request: Schema.String },
  GotConversationMenuMessage: { message: DropdownMenu.Message },
  GotMessageMenuMessage: { message: DropdownMenu.Message },
  GotRowMenuMessage: { message: ItemActionMenu.Message },
  UnmountedList: {},
  ActivatedNotification: { action: Action },
  ArchiveChanged: { request: Schema.String },
  ArchiveFailed: { request: Schema.String, error: Schema.String },
  AvatarMounted: {},
  SenderRuleSaved: { request: Schema.String },
  SenderRuleFailed: { request: Schema.String },
  LoadedList: {
    request: Schema.String,
    page: MailPage,
  },
  ListFailed: { request: Schema.String },
  LoadedUnread: { request: Schema.String, ...InboxUnread.fields },
  UnreadFailed: { request: Schema.String },
  UpdatedReadStatus: {
    request: Schema.String,
    id: InboxMessageId,
    status: InboxReadStatus,
  },
  ReadStatusFailed: { request: Schema.String, id: InboxMessageId },
  LoadedThread: { request: Schema.String, thread: Conversation },
  ThreadFailed: { request: Schema.String },
  LoadedEntry: { request: Schema.String, entry: MailEntry },
  LoadedImages: {
    request: Schema.String,
    id: MailMessageId,
    html: Schema.String,
    remoteImages: MailRemoteImages,
  },
  ImagesFailed: { request: Schema.String },
  EntryFailed: { request: Schema.String, missing: Schema.Boolean },
  SessionExpired: { request: Schema.String },
  FocusUpdated: {},
});
type Message = typeof Message.Type;
const toFiltersMessage = (message: typeof Filters.Message.Type) =>
  message._tag === "SessionExpired"
    ? Message.SessionExpired({ request: message.request })
    : Message.GotFiltersMessage({ message });

const foldFilters = Update.foldChild({
  update: Filters.update,
  read: (model: Model) =>
    supportsMailFilters(model.folder) && isListVisible(model)
      ? Option.some(model.filters)
      : Option.none(),
  write: (model, filters) => ({ ...model, filters }),
  toParentMessage: toFiltersMessage,
  foldOutMessage: () => (model) => ({ model }),
});

const toEmptyTrashDialogMessage = (message: typeof Dialog.Message.Type) =>
  Message.GotEmptyTrashDialogMessage({ message });

const foldEmptyTrashDialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.emptyTrashDialog),
  write: (model, emptyTrashDialog) => ({ ...model, emptyTrashDialog }),
  toParentMessage: toEmptyTrashDialogMessage,
  foldOutMessage: () => (model) => ({ model }),
});

const canEmptyTrash = (model: Model) =>
  model.folder === "trash" &&
  model.selected === null &&
  Boolean(model.list?.messages.length || model.emptyTrashError);

export const OutMessage = defineMessageUnion({
  Notify: { notification: Notification },
  DismissNotification: { key: Schema.String },
});
export type OutMessage = typeof OutMessage.Type;
type Result = Update.ReturnWithOutMessage<Model, Message, OutMessage>;
const notify = (
  result: Update.Return<Model, Message>,
  notification: Notification,
): Result => ({
  ...result,
  outMessage: OutMessage.Notify({ notification }),
});
const dismissNotification = (
  result: Update.Return<Model, Message>,
  key: string,
): Result => ({
  ...result,
  outMessage: OutMessage.DismissNotification({ key }),
});
const archiveKey = (id: string) => `mail-archive:${id}`;
const deleteKey = (id: string, conversation = false) =>
  conversation ? `mail-conversation-delete:${id}` : `mail-delete:${id}`;
const restoreKey = (id: string, batchId?: string) =>
  batchId ? `mail-trash-batch:${batchId}` : deleteKey(id);
const readKey = (id: string) => `mail-read:${id}`;
const priorityKey = (address: string) => `mail-sender-priority:${address}`;
const sent = (
  result: Update.Return<Model, Message>,
  key: string,
  message: typeof Compose.Message.Type & { _tag: "Sent" },
): Result =>
  notify(result, {
    key,
    variant:
      !message.saved || message.completion === "failed"
        ? "Warning"
        : message.completion === "new-mail"
          ? "Info"
          : "Success",
    title: sentNotice(message.saved, message.completion),
  });

const toAttachmentMessage = (message: typeof Attachments.Message.Type) =>
  message._tag === "SessionExpired"
    ? Message.SessionExpired({ request: message.request })
    : Message.GotAttachmentMessage({ message });

const foldAttachments = Update.foldChild({
  update: Attachments.update,
  read: (model: Model) => Option.some(model.attachmentPreview),
  write: (model, attachmentPreview) => ({ ...model, attachmentPreview }),
  toParentMessage: toAttachmentMessage,
});

const toAttachmentPopoverMessage = (message: typeof Popover.Message.Type) =>
  Message.GotAttachmentPopoverMessage({ message });
const foldAttachmentPopover = Update.foldChild({
  update: Popover.update,
  read: (model: Model) => Option.some(model.attachmentPopover),
  write: (model, attachmentPopover) => ({ ...model, attachmentPopover }),
  toParentMessage: toAttachmentPopoverMessage,
  foldOutMessage: () => (model) => ({ model }),
});

const toRecoveryMessage = (message: typeof Recovery.Message.Type) =>
  message._tag === "SessionExpired"
    ? Message.SessionExpired({ request: message.request })
    : Message.GotRecoveryMessage({ message });
const foldRecovery = Update.foldChild({
  update: Recovery.update,
  read: (model: Model) => Option.some(model.recovery),
  write: (model, recovery) => ({ ...model, recovery }),
  toParentMessage: toRecoveryMessage,
});

const toComposeMessage = (message: typeof Compose.Message.Type) =>
  message._tag === "SessionExpired"
    ? Message.SessionExpired({ request: message.request })
    : Message.GotComposeMessage({ message });

const foldCompose = Update.foldChild({
  update: Compose.update,
  read: (model: Model) => Option.some(model.compose),
  write: (model, compose) => ({ ...model, compose }),
  toParentMessage: toComposeMessage,
});

export const composeSender = (model: Model) =>
  model.sender ?? model.list?.sender;

export const composeView = Submodel.defineView<Model, Message>((model, h) =>
  h.submodel({
    slotId: "inbox-compose",
    view: Compose.view,
    model: model.compose,
    toParentMessage: toComposeMessage,
  }),
);

const toQuickReplyMessage = (message: typeof QuickReply.Message.Type) =>
  message._tag === "SessionExpired"
    ? Message.SessionExpired({ request: message.request })
    : Message.GotQuickReplyMessage({ message });

const foldQuickReply = Update.foldChild({
  update: QuickReply.update,
  read: (model: Model) => Option.some(model.quickReply),
  write: (model, quickReply) => ({ ...model, quickReply }),
  toParentMessage: toQuickReplyMessage,
});

export const closeFolderSheet = () =>
  Message.GotFolderSheetMessage({ message: Sheet.Message.RequestedClose() });

const foldFolderSheet = Update.foldChild({
  update: Sheet.update,
  read: (model: Model) => Option.some(model.folderSheet),
  write: (model, folderSheet) => ({ ...model, folderSheet }),
  toParentMessage: (message) => Message.GotFolderSheetMessage({ message }),
  foldOutMessage: () => (model) => ({ model }),
});

const FocusEntry = Mount.define("FocusInboxEntry", {
  messages: [Message.FocusUpdated],
  execute: ({ element }) =>
    Effect.sync(() => {
      if (element instanceof HTMLElement)
        element.focus({ preventScroll: true });
      return Message.FocusUpdated();
    }),
});

const WatchLayout = Mount.defineStream("WatchMailLayout", {
  messages: [Message.ChangedLayoutWidth],
  execute: () =>
    watchWorkspaceWidth().pipe(
      Stream.map((wide) => Message.ChangedLayoutWidth({ wide })),
    ),
});

const SaveSplitView = Command.define("SaveMailSplitView", {
  args: { split: Schema.Boolean },
  messages: [Message.FinishedSavingSplitView],
  execute: ({ split }) =>
    Effect.try(() => localStorage.setItem(splitViewKey, String(split))).pipe(
      Effect.ignore,
      Effect.as(Message.FinishedSavingSplitView()),
    ),
});

const FocusAttachmentButton = Command.define("FocusMailAttachments", {
  messages: [Message.FocusUpdated],
  execute: focus(`#${Popover.buttonId(initial.attachmentPopover.id)}`, {
    preventScroll: true,
  }).pipe(Effect.ignore, Effect.as(Message.FocusUpdated())),
});

const FocusList = Command.define("FocusInboxConversationList", {
  args: { id: MailMessageId },
  messages: [Message.FocusUpdated],
  execute: ({ id }) => {
    const list = ".inbox:not([data-panel]) .inbox-list";
    return focus(`${list} [data-message-id="${CSS.escape(id)}"]`, {
      preventScroll: true,
    }).pipe(
      Effect.catch(() => focus(list, { preventScroll: true })),
      Effect.ignore,
      Effect.as(Message.FocusUpdated()),
    );
  },
});

const RecoverRowFocus = Command.define("RecoverMailRowFocus", {
  args: { folder: MailboxView, neighborId: Schema.NullOr(MailMessageId) },
  messages: [Message.FocusUpdated],
  execute: ({ folder, neighborId }) =>
    Render.afterCommit.pipe(
      Effect.andThen(
        Effect.sync(() => {
          const list = document.querySelector<HTMLElement>(
            `.inbox-list[data-folder="${folder}"]:not([inert])`,
          );
          if (list && document.activeElement === document.body) {
            const trigger = neighborId
              ? document.getElementById(
                  ItemActionMenu.triggerId(rowActions.id, neighborId),
                )
              : null;
            const link = neighborId
              ? document.getElementById(
                  ItemActionMenu.rowLinkId(rowActions.id, neighborId),
                )
              : null;
            const target = trigger?.getClientRects().length
              ? trigger
              : (link ?? list);
            target.focus({ preventScroll: true });
          }
          return Message.FocusUpdated();
        }),
      ),
    ),
});

const FocusMessageSummary = Command.define("FocusInboxMessageSummary", {
  args: { id: MailMessageId },
  messages: [Message.FocusUpdated],
  execute: ({ id }) =>
    focus(`.inbox-reader [data-thread-message-id="${CSS.escape(id)}"]`, {
      preventScroll: true,
    }).pipe(Effect.ignore, Effect.as(Message.FocusUpdated())),
});

const ObserveListEnd = Mount.defineStream("ObserveInboxListEnd", {
  args: { folder: MailboxView, cursor: Schema.String },
  messages: [Message.RequestedMore],
  execute: ({ element, folder, cursor, viewStateChanges }) =>
    viewStateChanges.pipe(
      Stream.switchMap((state) =>
        state === "Paused"
          ? Stream.empty
          : Stream.callback<typeof Message.RequestedMore.Type>((queue) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  const observer = new IntersectionObserver(
                    (entries) => {
                      if (entries.some((entry) => entry.isIntersecting))
                        Queue.offerUnsafe(
                          queue,
                          Message.RequestedMore({ folder, cursor }),
                        );
                    },
                    {
                      root: element.parentElement,
                      rootMargin: "0px 0px 384px",
                    },
                  );
                  observer.observe(element);
                  return observer;
                }),
                (observer) => Effect.sync(() => observer.disconnect()),
              ).pipe(Effect.andThen(Effect.never)),
            ),
      ),
      Stream.take(1),
    ),
});

const LoadList = Command.define("LoadInboxList", {
  args: {
    request: Schema.String,
    cursor: Schema.NullOr(Schema.String),
    folder: MailboxView,
    minimum: Schema.Number,
    filters: MailFilters,
  },
  messages: [Message.LoadedList, Message.ListFailed, Message.SessionExpired],
  execute: ({ request, cursor, folder, minimum, filters }) =>
    Effect.tryPromise(async (signal) => {
      const path = mailboxApiPaths[folder];
      const params = new URLSearchParams();
      if (supportsMailFilters(folder) && mailFilterCount(filters))
        params.set("filters", JSON.stringify(filters));
      let nextCursor = cursor;
      let page: typeof MailPage.Type | null = null;
      do {
        if (nextCursor !== null) params.set("cursor", nextCursor);
        const response = await mailFetch(
          params.size ? path + "?" + params : path,
          {
            cache: "no-store",
            signal,
          },
        );
        if (response.status === 401) return Message.SessionExpired({ request });
        if (!response.ok) return Message.ListFailed({ request });
        const payload = await response.json();
        const next =
          folder === "sent"
            ? Schema.decodeUnknownSync(SentPage)(payload)
            : Schema.decodeUnknownSync(ConversationPage)(payload);
        page = page
          ? { ...next, messages: [...page.messages, ...next.messages] }
          : next;
        nextCursor = page.cursor;
      } while (nextCursor && !page.indexing && page.messages.length < minimum);
      return Message.LoadedList({ request, page });
    }).pipe(
      Effect.catch(() => Effect.succeed(Message.ListFailed({ request }))),
    ),
});

const LoadUnread = Command.define("LoadInboxUnread", {
  args: { request: Schema.String },
  messages: [
    Message.LoadedUnread,
    Message.UnreadFailed,
    Message.SessionExpired,
  ],
  execute: ({ request }) =>
    Effect.tryPromise(async (signal) => {
      const response = await mailFetch(inboxUnreadPath, {
        cache: "no-store",
        signal,
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      if (!response.ok) return Message.UnreadFailed({ request });
      const status = Schema.decodeUnknownSync(InboxUnread)(
        await response.json(),
      );
      return Message.LoadedUnread({ request, ...status });
    }).pipe(
      Effect.catch(() => Effect.succeed(Message.UnreadFailed({ request }))),
    ),
});

const SetUnread = Command.define("SetInboxUnread", {
  args: { request: Schema.String, id: InboxMessageId, unread: Schema.Boolean },
  messages: [
    Message.UpdatedReadStatus,
    Message.ReadStatusFailed,
    Message.SessionExpired,
  ],
  execute: ({ request, id, unread }) =>
    Effect.tryPromise(async (signal) => {
      const response = await mailFetch(inboxReadApi(id), {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-effect-auth-csrf": "1",
        },
        body: JSON.stringify({ unread }),
        signal,
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      if (!response.ok) return Message.ReadStatusFailed({ request, id });
      const status = Schema.decodeUnknownSync(InboxReadStatus)(
        await response.json(),
      );
      return Message.UpdatedReadStatus({ request, id, status });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(Message.ReadStatusFailed({ request, id })),
      ),
    ),
});

const LoadThread = Command.define("LoadMailConversation", {
  args: {
    request: Schema.String,
    id: MailMessageId,
    folder: MailboxView,
    filters: MailFilters,
  },
  messages: [
    Message.LoadedThread,
    Message.ThreadFailed,
    Message.SessionExpired,
  ],
  execute: ({ request, id, folder, filters }) =>
    Effect.tryPromise(async (signal) => {
      const params = new URLSearchParams();
      if (supportsMailFilters(folder)) {
        params.set("view", folder);
        if (filters.people.length || filters.companies.length)
          params.set("filters", JSON.stringify({ ...filters, status: "all" }));
      }
      const response = await mailFetch(
        conversationApi(id) + (params.size ? "?" + params : ""),
        {
          cache: "no-store",
          signal,
        },
      );
      if (response.status === 401) return Message.SessionExpired({ request });
      if (response.status === 404)
        return Message.LoadedThread({ request, thread: { messages: [] } });
      if (!response.ok) return Message.ThreadFailed({ request });
      const thread = Schema.decodeUnknownSync(Conversation)(
        await response.json(),
      );
      return Message.LoadedThread({ request, thread });
    }).pipe(
      Effect.catch(() => Effect.succeed(Message.ThreadFailed({ request }))),
    ),
});

const LoadEntry = Command.define("LoadInboxEntry", {
  args: {
    request: Schema.String,
    id: MailMessageId,
    folder: MailFolder,
    trash: Schema.Boolean,
  },
  messages: [Message.LoadedEntry, Message.EntryFailed, Message.SessionExpired],
  execute: ({ request, id, folder, trash }) =>
    Effect.tryPromise(async (signal) => {
      const response = await mailFetch(
        trash ? `${trashApiPath}/${id}` : mailMessageApi(folder, id),
        {
          cache: "no-store",
          signal,
        },
      );
      if (response.status === 401) return Message.SessionExpired({ request });
      if (!response.ok)
        return Message.EntryFailed({
          request,
          missing: response.status === 404,
        });
      const payload = await response.json();
      const entry =
        folder === "sent"
          ? Schema.decodeUnknownSync(SentEntry)(payload)
          : Schema.decodeUnknownSync(InboxEntry)(payload);
      return Message.LoadedEntry({ request, entry });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(Message.EntryFailed({ request, missing: false })),
      ),
    ),
});

const LoadImages = Command.define("LoadMailImages", {
  args: {
    request: Schema.String,
    ...MessageLocation.fields,
    includeBlocked: Schema.Boolean,
    trash: Schema.Boolean,
  },
  messages: [
    Message.LoadedImages,
    Message.ImagesFailed,
    Message.SessionExpired,
  ],
  execute: ({ request, id, folder, includeBlocked, trash }) =>
    Effect.tryPromise(async (signal) => {
      const response = await mailFetch(
        `${trash ? `${trashApiPath}/${id}` : mailMessageApi(folder, id)}?images=${includeBlocked ? "all" : "safe"}`,
        { cache: "no-store", signal, headers: { "x-effect-auth-csrf": "1" } },
      );
      if (response.status === 401) return Message.SessionExpired({ request });
      if (!response.ok) return Message.ImagesFailed({ request });
      const preview = Schema.decodeUnknownSync(
        Schema.Struct({ html: Schema.String, remoteImages: MailRemoteImages }),
      )(await response.json());
      return Message.LoadedImages({ request, id, ...preview });
    }).pipe(
      Effect.catch(() => Effect.succeed(Message.ImagesFailed({ request }))),
    ),
});

const DeleteEntry = Command.define("DeleteInboxEntry", {
  args: {
    request: Schema.String,
    ...MessageLocation.fields,
    conversationView: Schema.optionalKey(MailboxView),
  },
  messages: [
    Message.DeletedEntry,
    Message.DeleteFailed,
    Message.SessionExpired,
  ],
  execute: ({ request, id, folder, conversationView }) =>
    Effect.tryPromise(async (signal) => {
      const response = await mailFetch(
        conversationView ? conversationApi(id) : mailMessageApi(folder, id),
        {
          method: "DELETE",
          headers: { "x-effect-auth-csrf": "1" },
          signal,
        },
      );
      if (response.status === 401) return Message.SessionExpired({ request });
      if (conversationView && response.ok) {
        const conversation = Schema.decodeUnknownSync(TrashedConversation)(
          await response.json(),
        );
        return Message.DeletedEntry({ id, request, conversation });
      }
      return response.status === 204
        ? Message.DeletedEntry({ id, request })
        : Message.DeleteFailed({ request });
    }).pipe(
      Effect.catch(() => Effect.succeed(Message.DeleteFailed({ request }))),
    ),
});

const EmptyTrash = Command.define("EmptyMailTrash", {
  args: { request: Schema.String },
  messages: [
    Message.EmptiedTrash,
    Message.EmptyTrashFailed,
    Message.SessionExpired,
  ],
  execute: ({ request }) =>
    Effect.tryPromise(async (signal) => {
      const response = await mailFetch(trashApiPath, {
        method: "DELETE",
        headers: { "x-effect-auth-csrf": "1" },
        signal,
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      return response.status === 204
        ? Message.EmptiedTrash({ request })
        : Message.EmptyTrashFailed({ request });
    }).pipe(
      Effect.catch(() => Effect.succeed(Message.EmptyTrashFailed({ request }))),
    ),
});

const SaveArchive = Command.define("SaveConversationArchive", {
  args: { ...ArchiveChange.fields, request: Schema.String },
  messages: [
    Message.ArchiveChanged,
    Message.ArchiveFailed,
    Message.SessionExpired,
  ],
  execute: ({ id, archived, request }) =>
    Effect.tryPromise(async (signal) => {
      const response = await mailFetch(conversationArchiveApi(id), {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-effect-auth-csrf": "1",
        },
        body: JSON.stringify({ archived }),
        signal,
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      if (response.status === 204) return Message.ArchiveChanged({ request });
      return Message.ArchiveFailed({
        request,
        error:
          response.status === 409
            ? "A new reply arrived. Review it before archiving."
            : "Could not update Archive. Try again.",
      });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          Message.ArchiveFailed({
            request,
            error: "Could not update Archive. Try again.",
          }),
        ),
      ),
    ),
});

const SaveSenderRule = Command.define("SaveMailSenderRule", {
  args: SenderRuleRequest.fields,
  messages: [
    Message.SenderRuleSaved,
    Message.SenderRuleFailed,
    Message.SessionExpired,
  ],
  execute: ({ request, address, priority }) =>
    Effect.tryPromise(async (signal) => {
      const response = await mailFetch(senderRuleApiPath, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-effect-auth-csrf": "1",
        },
        body: JSON.stringify({ address, priority }),
        signal,
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      return response.status === 204
        ? Message.SenderRuleSaved({ request })
        : Message.SenderRuleFailed({ request });
    }).pipe(
      Effect.catch(() => Effect.succeed(Message.SenderRuleFailed({ request }))),
    ),
});

const DownloadOriginal = Command.define("DownloadInboxOriginal", {
  args: { id: InboxMessageId, trash: Schema.Boolean },
  messages: [Message.DownloadStarted],
  execute: ({ id, trash }) =>
    Effect.sync(() => {
      const link = document.createElement("a");
      link.href = selectedMailboxUrl(
        trash ? `${trashApiPath}/${id}/original` : inboxOriginalApi(id),
      );
      link.download = id;
      document.body.append(link);
      link.click();
      link.remove();
      return Message.DownloadStarted();
    }),
});

const loadList = (
  model: Model,
  cursor: string | null,
): Update.Return<Model, Message> => {
  if (model.listRequest !== null) return { model };
  const request = crypto.randomUUID();
  return {
    model: {
      ...model,
      listRequest: { id: request, cursor },
      listRefreshQueued: false,
      listError: null,
    },
    commands: [
      LoadList({
        request,
        cursor,
        folder: model.folder,
        filters: model.filters.selection,
        minimum:
          cursor === null && model.folder !== "sent"
            ? (visibleList(model)?.messages.length ?? 0)
            : 0,
      }),
    ],
  };
};

const refreshList = (model: Model): Update.Return<Model, Message> =>
  model.listRequest
    ? { model: { ...model, listRefreshQueued: true } }
    : loadList(model, null);

const changeArchive = (
  model: Model,
  change: typeof ArchiveChange.Type,
  selected: Model["selected"],
  subject?: string,
): Update.Return<Model, Message> => {
  const request = crypto.randomUUID();
  return {
    model: {
      ...model,
      archiveRequest: {
        ...change,
        request,
        folder: model.folder,
        selected,
        subject,
      },
    },
    commands: [SaveArchive({ ...change, request })],
  };
};

const loadEntry = (model: Model): Update.Return<Model, Message> => {
  if (!model.active || model.entryRequest !== null) return { model };
  const request = crypto.randomUUID();
  return {
    model: { ...model, entryRequest: request, entryError: null },
    commands: [
      LoadEntry({ request, ...model.active, trash: model.folder === "trash" }),
    ],
  };
};

const loadImages = (
  model: Model,
  includeBlocked = false,
): Update.Return<Model, Message> => {
  if (
    !model.active ||
    model.entry?.id !== model.active.id ||
    model.imageRequest
  )
    return { model };
  const request = crypto.randomUUID();
  return {
    model: { ...model, imageRequest: request, imageError: false },
    commands: [
      LoadImages({
        request,
        ...model.active,
        includeBlocked,
        trash: model.folder === "trash",
      }),
    ],
  };
};

const selectMessage = (model: Model, active: Model["active"]) =>
  loadEntry({
    ...model,
    active,
    messageMenu: initial.messageMenu,
    entry: null,
    entryRequest: null,
    entryError: null,
    imageRequest: null,
    imageError: false,
    showPlainText: false,
    attachmentPreview: Attachments.initial,
    attachmentPopover: Popover.init({ id: "mail-attachments" }),
  });

const refreshThread = (model: Model): Update.Return<Model, Message> => {
  if (!model.selected) return { model };
  if (model.folder === "trash")
    return model.entry ? { model } : loadEntry(model);
  if (model.threadRequest)
    return { model: { ...model, threadRefreshQueued: true } };
  const request = crypto.randomUUID();
  return {
    model: {
      ...model,
      threadRequest: request,
      threadRefreshQueued: false,
      threadFailed: false,
    },
    commands: [
      LoadThread({
        id: model.selected,
        request,
        folder: model.folder,
        filters: model.filters.selection,
      }),
    ],
  };
};

const withThread = (result: Update.Return<Model, Message>) => {
  const thread = refreshThread(result.model);
  return {
    model: thread.model,
    commands: [...(result.commands ?? []), ...(thread.commands ?? [])],
  };
};

const refreshUnread = (model: Model): Update.Return<Model, Message> => {
  if (model.unreadRequest)
    return { model: { ...model, unreadRefreshQueued: true } };
  const request = crypto.randomUUID();
  return {
    model: { ...model, unreadRequest: request, unreadRefreshQueued: false },
    commands: [LoadUnread({ request })],
  };
};

const withUnread = (result: Update.Return<Model, Message>) => {
  const unread = refreshUnread(result.model);
  return {
    model: unread.model,
    commands: [...(result.commands ?? []), ...(unread.commands ?? [])],
  };
};

const afterSend = (
  result: Update.Return<Model, Message>,
  message: Extract<typeof Compose.Message.Type, { _tag: "Sent" }>,
  showReply: boolean,
): Update.Return<Model, Message> => {
  if (!message.saved && !message.completion) return result;
  const selected =
    showReply && message.sentId
      ? selectMessage(result.model, { id: message.sentId, folder: "sent" })
      : result;
  const list = refreshList(selected.model);
  return withUnread(
    withThread({
      model: list.model,
      commands: [...(selected.commands ?? []), ...(list.commands ?? [])],
    }),
  );
};

const entryUnread = (model: Model) => {
  const entry = model.entry;
  if (!entry || !("receivedAt" in entry)) return false;
  return (
    model.thread?.messages.find(({ id }) => id === entry.id)?.unread ??
    entry.unread ??
    false
  );
};

type Summary = typeof ConversationSummary.Type;
type ReadStatus = typeof InboxReadStatus.Type;

const matchesReadFilter = (model: Model, row: Summary) => {
  const status = model.filters.selection.status;
  const unread = row.unreadCount > 0;
  return status === "all" || unread === (status === "unread");
};

const withUnreadIds = (row: Summary, unreadIncomingIds: readonly string[]) => ({
  ...row,
  unreadIncomingIds,
  unreadCount: unreadIncomingIds.length,
});

type ListRow = NonNullable<Model["list"]>["messages"][number];

const rowTime = (row: ListRow) =>
  "sentAt" in row ? row.sentAt : (row.receivedAt ?? row.lastMessageAt);

const compareRows = (left: ListRow, right: ListRow) =>
  rowTime(right) - rowTime(left) ||
  Number(left.id < right.id) - Number(left.id > right.id);

const retainThreadRow = (model: Model): Model["list"] => {
  const { list, thread } = model;
  const row = thread?.summary;
  // This row meets the mailbox and contact filters. Retain it across read-state changes.
  if (
    !list ||
    !row ||
    matchesReadFilter(model, row) ||
    list.messages.some(({ id }) => id === row.id)
  )
    return list;
  return { ...list, messages: [...list.messages, row].sort(compareRows) };
};

const visibleList = (model: Model): Model["list"] => {
  const { list, readRequests } = model;
  if (!list || !supportsMailFilters(model.folder)) return list;
  const pending = Object.entries(readRequests);
  if (!pending.length && model.filters.selection.status === "all") return list;
  const project = (row: Summary) => {
    const changes = pending.filter(
      ([id, change]) =>
        row.latestIncomingId === (change.latestIncomingId ?? id) ||
        row.unreadIncomingIds?.includes(id),
    );
    if (!changes.length) return row;
    const ids = new Set(row.unreadIncomingIds);
    for (const [id, { unread }] of changes) {
      if (unread) ids.add(id);
      else ids.delete(id);
    }
    return withUnreadIds(row, [...ids]);
  };
  const messages = list.messages.flatMap<ListRow>((row) => {
    if ("sentAt" in row) return [row];
    const projected = project(row);
    return matchesReadFilter(model, projected) ? [projected] : [];
  });
  return { ...list, messages };
};

export const visibleUnreadCount = (model: Model) => {
  let count = model.unreadCount;
  for (const { unread, previousUnread, countsInInbox } of Object.values(
    model.readRequests,
  ))
    if (countsInInbox) count += Number(unread) - Number(previousUnread);
  return Math.max(0, count);
};

const projectThread = (model: Model): Model["thread"] => {
  if (!model.thread || !Object.keys(model.readRequests).length)
    return model.thread;
  return {
    ...model.thread,
    messages: model.thread.messages.map((message) => {
      const change = model.readRequests[message.id];
      return change ? { ...message, unread: change.unread } : message;
    }),
  };
};

const nextReadCommand = (model: Model) => {
  const item = Object.entries(model.readRequests)[0];
  if (!item) return [];
  const [id, { request, unread }] = item;
  return [SetUnread({ id, request, unread })];
};

const setUnread = (
  model: Model,
  ids: readonly string[],
  unread: boolean,
  userInitiated = false,
  row?: Summary,
): Update.Return<Model, Message> => {
  const readRequests = { ...model.readRequests };
  const latestIncomingId =
    row?.latestIncomingId ??
    model.thread?.messages.findLast(({ folder }) => folder === "inbox")?.id ??
    null;
  let added = false;
  for (const id of ids) {
    if (readRequests[id]) continue;
    const message = model.thread?.messages.find((message) => message.id === id);
    const archived =
      message?.archived ??
      row?.archivedIncomingIds?.includes(id) ??
      row?.archived ??
      model.thread?.archived ??
      model.folder === "archive";
    added = true;
    readRequests[id] = {
      request: crypto.randomUUID(),
      userInitiated,
      unread,
      previousUnread: !unread,
      countsInInbox: !archived,
      latestIncomingId,
      subject:
        (row ? conversationSubject([row]) : undefined) ??
        (model.entry?.id === id
          ? model.entry.subject || "(no subject)"
          : undefined),
    };
  }
  if (!added) return { model };
  const next = {
    ...model,
    list: retainThreadRow(model),
    readFailed: null,
    readRequests,
  };
  return {
    model: next,
    // Keep confirmed mailbox counts in write order.
    commands: Object.keys(model.readRequests).length
      ? []
      : nextReadCommand(next),
  };
};

const finishUnread = (
  model: Model,
  request: string,
  status?: typeof InboxUnread.Type,
) => {
  if (request !== model.unreadRequest) return { model };
  const next = {
    ...model,
    ...(status && {
      unreadCount: status.unreadCount,
      sender: status.sender ?? null,
    }),
    unreadRequest: null,
  };
  return next.unreadRefreshQueued ? refreshUnread(next) : { model: next };
};

const finishReadStatus = (model: Model, id: string): Model => {
  const { [id]: _completed, ...readRequests } = model.readRequests;
  return {
    ...model,
    readRequests,
    readFailed: model.readFailed === id ? null : model.readFailed,
  };
};

const reconcileReadStatus = (
  model: Model,
  id: string,
  status: ReadStatus,
): Model => {
  const { latestIncomingId, unreadIncomingIds, unreadCount } = status;
  const unreadIds = new Set(unreadIncomingIds);
  const { list, thread, entry } = model;
  const summary = thread?.summary;
  const updatedSummary =
    summary?.latestIncomingId === latestIncomingId
      ? withUnreadIds(summary, unreadIncomingIds)
      : summary;
  const messages = list?.messages.map((row) =>
    "latestIncomingId" in row && row.latestIncomingId === latestIncomingId
      ? withUnreadIds(row, unreadIncomingIds)
      : row,
  );
  const related = thread?.messages.some(
    (message) => message.id === latestIncomingId || message.id === id,
  );
  const readRequests = { ...model.readRequests };
  for (const [pendingId, change] of Object.entries(readRequests)) {
    if (change.latestIncomingId === latestIncomingId)
      readRequests[pendingId] = {
        ...change,
        previousUnread: unreadIds.has(pendingId),
      };
  }
  return {
    ...model,
    unreadCount,
    readRequests,
    list: list && messages ? { ...list, messages } : list,
    thread:
      thread && related
        ? {
            ...thread,
            ...(updatedSummary ? { summary: updatedSummary } : {}),
            messages: thread.messages.map((message) =>
              message.folder === "inbox"
                ? { ...message, unread: unreadIds.has(message.id) }
                : message,
            ),
          }
        : thread,
    entry:
      entry && "receivedAt" in entry && (entry.id === id || related)
        ? {
            ...entry,
            unread: entry.id === id ? status.unread : unreadIds.has(entry.id),
          }
        : entry,
  };
};

const advanceLiveVersion = (model: Model, version: number): Model => {
  const versions = new Set(
    model.localReadVersions.filter((local) => local > version),
  );
  while (versions.delete(version + 1)) version++;
  return { ...model, liveVersion: version, localReadVersions: [...versions] };
};

const catchUp = (
  model: Model,
  change: typeof LiveChange.Type,
): Update.Return<Model, Message> => {
  const { version, refreshView } = change;
  if (version !== null && version <= model.liveVersion) return { model };
  if (Object.keys(model.readRequests).length) {
    const previous = model.liveChangeQueued;
    return {
      model: {
        ...model,
        liveChangeQueued: {
          version:
            previous?.version === null || version === null
              ? null
              : Math.max(previous?.version ?? -1, version),
          refreshView: refreshView || Boolean(previous?.refreshView),
        },
      },
    };
  }
  const next = version === null ? model : advanceLiveVersion(model, version);
  return withUnread(
    refreshView ? withThread(refreshList(next)) : { model: next },
  );
};

const completeRead = (model: Model): Update.Return<Model, Message> => {
  const commands = nextReadCommand(model);
  if (commands.length) return { model, commands };
  if (!model.liveChangeQueued) return { model };
  return catchUp({ ...model, liveChangeQueued: null }, model.liveChangeQueued);
};

const restartOverlappingReads = (result: Update.Return<Model, Message>) => {
  // These requests may have captured data before the PATCH committed.
  const { listRequest, threadRequest, unreadRequest, entryRequest } =
    result.model;
  const append = (next: Update.Return<Model, Message>) => {
    result = {
      ...result,
      model: next.model,
      commands: [...(result.commands ?? []), ...(next.commands ?? [])],
    };
  };
  if (listRequest)
    append(
      loadList({ ...result.model, listRequest: null }, listRequest.cursor),
    );
  if (threadRequest)
    append(refreshThread({ ...result.model, threadRequest: null }));
  if (unreadRequest)
    append(refreshUnread({ ...result.model, unreadRequest: null }));
  if (entryRequest) append(loadEntry({ ...result.model, entryRequest: null }));
  return result;
};

const quoteMessage = (entry: typeof MailEntry.Type) => {
  const body = entry.text.trimEnd();
  if (!body) return "";
  const quote = body.replace(/\r\n?/gu, "\n").replace(/^/gmu, "> ");
  const limit = Math.floor(inboxComposeLimits.text / 2);
  const clipped = quote.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "");
  const from =
    (entry.people?.sender?.address || entry.from)
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 300)
      .replace(/[\uD800-\uDBFF]$/u, "") || "The sender";
  const truncated = quote.length > limit || entry.preview === "truncated";
  return `\n\n${from} wrote:\n${clipped}${truncated ? "\n> [Original message truncated]" : ""}`;
};

const toConversationMenuMessage = (message: typeof DropdownMenu.Message.Type) =>
  Message.GotConversationMenuMessage({ message });

const toMessageMenuMessage = (message: typeof DropdownMenu.Message.Type) =>
  Message.GotMessageMenuMessage({ message });

const toRowMenuMessage = (message: ItemActionMenu.Message) =>
  Message.GotRowMenuMessage({ message });

const selectedMessage = (model: Model): Model["active"] =>
  model.active ??
  (model.selected
    ? { id: model.selected, folder: messageFolder(model.selected) }
    : null);

const changeSenderPriority = (
  model: Model,
  rule: typeof SenderRule.Type | undefined,
  priority: typeof SenderPriority.Type,
): Update.Return<Model, Message> => {
  if (!rule || model.senderRuleRequest || rule.priority === priority)
    return { model };
  const change = {
    address: rule.address,
    priority,
    request: crypto.randomUUID(),
  };
  return {
    model: { ...model, senderRuleRequest: change },
    commands: [SaveSenderRule(change)],
  };
};

const foldConversationMenu = Update.foldChild({
  update: conversationMenu.update,
  read: (model: Model) => Option.some(model.conversationMenu),
  write: (model, conversationMenu) => ({ ...model, conversationMenu }),
  toParentMessage: toConversationMenuMessage,
  foldOutMessage:
    ({ value }) =>
    (model) => {
      if (value === "archive") {
        if (model.archiveRequest || model.folder === "sent" || !model.thread)
          return { model };
        const newest = model.thread.messages.findLast(
          ({ folder }) => folder === "inbox",
        );
        return newest
          ? changeArchive(
              model,
              { id: newest.id, archived: !model.thread.archived },
              model.selected,
              conversationSubject(model.thread.messages),
            )
          : { model };
      }
      return changeSenderPriority(model, model.thread?.senderRule, value);
    },
});

const foldMessageMenu = Update.foldChild({
  update: messageMenu.update,
  read: (model: Model) => Option.some(model.messageMenu),
  write: (model, messageMenu) => ({ ...model, messageMenu }),
  toParentMessage: toMessageMenuMessage,
  foldOutMessage:
    ({ value }) =>
    (model) => {
      const { active, entry } = model;
      if (!active) return { model };
      if (value === "togglePlainText")
        return entry?.html
          ? { model: { ...model, showPlainText: !model.showPlainText } }
          : { model };
      if (value === "loadBlockedImages")
        return entry?.remoteImages?.blocked
          ? loadImages(model, true)
          : { model };
      if (value === "retryImages") return loadImages(model);
      if (value === "restore")
        return model.folder === "trash"
          ? foldRecovery(
              model,
              Recovery.Message.Restore({
                id: active.id,
                subject: entry?.subject,
              }),
            )
          : { model };
      if (model.folder === "trash" && value !== "download") return { model };
      if (active.folder !== "inbox") return { model };
      if (value === "download") {
        return {
          model,
          commands: [
            DownloadOriginal({
              id: active.id,
              trash: model.folder === "trash",
            }),
          ],
        };
      }
      return value === "toggleUnread" &&
        entry?.id === active.id &&
        "receivedAt" in entry
        ? setUnread(model, [entry.id], !entryUnread(model), true)
        : { model };
    },
});

const rowReadTargets = (row: typeof ConversationSummary.Type) =>
  row.unreadCount > 0
    ? (row.unreadIncomingIds ?? [])
    : row.latestIncomingId
      ? [row.latestIncomingId]
      : [];

const requestConversationDelete = (
  model: Model,
  row: typeof ConversationSummary.Type,
): Update.Return<Model, Message> => {
  const deletion = {
    id: row.id,
    folder: messageFolder(row.id),
    conversationView: model.folder,
    subject: conversationSubject([row]),
    request: crypto.randomUUID(),
  };
  return {
    model: { ...model, deleteRequest: deletion },
    commands: [DeleteEntry(deletion)],
  };
};

const foldRowMenu = Update.foldChild({
  update: rowMenu.update,
  read: (model: Model) =>
    isListVisible(model) ? Option.some(model.rowActions) : Option.none(),
  write: (model, rowActions) => ({ ...model, rowActions }),
  toParentMessage: toRowMenuMessage,
  foldOutMessage:
    ({ key, action }): Update.Step<Model, Message> =>
    (model) => {
      const row = visibleList(model)?.messages.find(({ id }) => id === key);
      if (
        !row ||
        "sentAt" in row ||
        !rowActionItems(model, row).some(
          (item) => item.action === action && !item.disabled,
        )
      )
        return { model };
      const subject = conversationSubject([row]);
      switch (action) {
        case "delete":
          return requestConversationDelete(model, row);
        case "restore":
          return foldRecovery(
            model,
            Recovery.Message.Restore({
              id: row.id,
              subject,
              ...(row.trashBatch ? { batchId: row.trashBatch } : {}),
            }),
          );
        case "archive":
          return row.latestIncomingId
            ? changeArchive(
                model,
                { id: row.latestIncomingId, archived: !row.archived },
                null,
                subject,
              )
            : { model };
        case "toggleUnread":
          return setUnread(
            model,
            rowReadTargets(row),
            row.unreadCount === 0,
            true,
            row,
          );
        default:
          return changeSenderPriority(model, row.senderRule, action);
      }
    },
});

const withLayout = (model: Model, layout: Model["layout"]): Model => {
  const next = { ...model, layout };
  return isListVisible(model) && !isListVisible(next)
    ? { ...next, filters: Filters.resetMenu(next.filters), rowActions }
    : next;
};

const transition = (model: Model, message: Message): Result =>
  Message.match<Result>(message, {
    ChangedLayoutWidth: ({ wide }) => ({
      model:
        model.layout.wide === wide
          ? model
          : withLayout(model, { ...model.layout, wide }),
    }),
    ToggledSplitView: () => {
      if (!model.layout.wide) return { model };
      const split = !model.layout.split;
      return {
        model: withLayout(model, { ...model.layout, split }),
        commands: [SaveSplitView({ split })],
      };
    },
    FinishedSavingSplitView: () => ({ model }),
    GotFiltersMessage: ({ message }) => {
      const result = foldFilters(model, message);
      if (model.filters.selection === result.model.filters.selection)
        return result;
      const restarted = loadList(
        { ...result.model, rowActions, list: null, listRequest: null },
        null,
      );
      const before = model.filters.selection;
      const after = restarted.model.filters.selection;
      const updated =
        before.people === after.people && before.companies === after.companies
          ? restarted
          : withThread({
              ...restarted,
              model: {
                ...restarted.model,
                thread: model.thread && { ...model.thread, summary: undefined },
                threadRequest: null,
              },
            });
      return {
        model: updated.model,
        commands: [...(result.commands ?? []), ...(updated.commands ?? [])],
      };
    },
    GotFolderSheetMessage: ({ message }) =>
      message._tag === "RequestedOpen" &&
      !matchMedia(workspaceDrawerMedia).matches
        ? { model }
        : foldFolderSheet(model, message),
    GotConversationMenuMessage: ({ message }) =>
      foldConversationMenu(model, message),
    GotMessageMenuMessage: ({ message }) => foldMessageMenu(model, message),
    GotRowMenuMessage: ({ message }) => {
      const result = foldRowMenu(model, message);
      const deletion = result.model.deleteRequest;
      return deletion && !model.deleteRequest
        ? dismissNotification(result, deleteKey(deletion.id, true))
        : result;
    },
    UnmountedList: () => ({ model: { ...model, rowActions } }),
    Opened: ({ id, folder, focusMessage = false, refresh }) => {
      const base =
        folder === model.folder
          ? model
          : {
              ...initial,
              folder,
              layout: model.layout,
              filters: Filters.resetMenu(model.filters),
              folderSheet: model.folderSheet,
              compose: model.compose,
              recovery: model.recovery,
              quickReply: model.quickReply,
              deleteRequest: model.deleteRequest,
              emptyTrashRequest: model.emptyTrashRequest,
              emptyTrashError: model.emptyTrashError,
              archiveRequest: model.archiveRequest,
              senderRuleRequest: model.senderRuleRequest,
              sender: model.sender,
              unreadCount: model.unreadCount,
              unreadRequest: model.unreadRequest,
              unreadRefreshQueued: model.unreadRefreshQueued,
              readRequests: model.readRequests,
              liveVersion: model.liveVersion,
              localReadVersions: model.localReadVersions,
              liveChangeQueued: model.liveChangeQueued,
            };
      const next =
        base.selected === id && base.focusMessage === focusMessage
          ? base
          : {
              ...base,
              selected: id,
              focusMessage,
              filters: Filters.resetMenu(base.filters),
              conversationMenu: initial.conversationMenu,
              messageMenu: initial.messageMenu,
              rowActions,
              emptyTrashDialog: initial.emptyTrashDialog,
              middleRevealed: false,
              active: id ? { id, folder: messageFolder(id) } : null,
              thread: null,
              threadRequest: null,
              threadRefreshQueued: false,
              threadFailed: false,
              entry: null,
              entryRequest: null,
              entryError: null,
              imageRequest: null,
              imageError: false,
              showPlainText: false,
              attachmentPreview: Attachments.initial,
              attachmentPopover: Popover.init({ id: "mail-attachments" }),
            };
      const previous = id === null ? base.selected : null;
      const list = refresh
        ? refreshList(next)
        : next.list
          ? { model: next }
          : loadList(next, null);
      const result = next.thread && !refresh ? list : withThread(list);
      if (!previous) return result;
      const row = visibleList(base)?.messages.find(
        ({ id }) =>
          id === previous ||
          (folder !== "sent" &&
            base.thread?.messages.some((message) => message.id === id)),
      );
      return {
        ...result,
        commands: [
          ...(result.commands ?? []),
          FocusList({ id: row?.id ?? previous }),
        ],
      };
    },
    RetriedList: () =>
      model.listError?.cursor
        ? loadList(model, model.listError.cursor)
        : withUnread(withThread(loadList(model, null))),
    GotAttachmentPopoverMessage: ({ message }) =>
      foldAttachmentPopover(model, message),
    GotAttachmentMessage: ({ message }) => {
      if (
        message._tag === "Opened" &&
        (model.entry?.id !== message.id ||
          !model.entry.attachments?.some(
            ({ part, preview }) => part === message.part && preview !== null,
          ))
      )
        return { model };
      const result = foldAttachments(
        message._tag === "Opened"
          ? { ...model, attachmentPopover: initial.attachmentPopover }
          : model,
        message,
      );
      // The preview action is removed with the popover. Restore focus to its
      // trigger after the dialog releases modal isolation.
      return message._tag === "GotDialogMessage" &&
        message.message._tag === "CompletedCloseDialog" &&
        !result.model.attachmentPreview.dialog.isOpen &&
        !result.model.attachmentPopover.isOpen
        ? {
            ...result,
            commands: [...(result.commands ?? []), FocusAttachmentButton()],
          }
        : result;
    },
    RefreshedUnread: () => refreshUnread(model),
    GotRecoveryMessage: ({ message }) => {
      const result = foldRecovery(model, message);
      if (
        message._tag === "Failed" &&
        message.request === model.recovery.request &&
        model.recovery.restoring
      )
        return notify(result, {
          key: restoreKey(model.recovery.restoring, model.recovery.batchId),
          variant: "Error",
          title: model.recovery.batchId
            ? "Could not restore this conversation. Try Undo again."
            : "Could not restore this message. Try Undo again.",
          description: model.recovery.subject,
          action: Action.RestoreMail({
            id: model.recovery.restoring,
            subject: model.recovery.subject,
            ...(model.recovery.batchId
              ? { batchId: model.recovery.batchId }
              : {}),
          }),
        });
      if (
        message._tag !== "Restored" ||
        model.recovery.request !== message.request ||
        model.recovery.restoring !== message.id
      )
        return result;
      const restored = new Set(message.members?.ids ?? [message.id]);
      const restoredSelection =
        model.folder === "trash" &&
        model.active &&
        restored.has(model.active.id);
      const updated =
        model.folder === "trash" && result.model.list
          ? {
              ...result.model,
              list: {
                ...result.model.list,
                messages: result.model.list.messages.filter(
                  ({ id }) => !restored.has(id),
                ),
              },
              listRequest: null,
            }
          : result.model;
      const next = restoredSelection
        ? {
            ...updated,
            selected: null,
            active: null,
            entry: null,
            entryRequest: null,
            imageRequest: null,
            attachmentPreview: Attachments.initial,
            attachmentPopover: Popover.init({ id: "mail-attachments" }),
          }
        : updated;
      const refreshed = withUnread(withThread(refreshList(next)));
      return dismissNotification(
        {
          model: refreshed.model,
          commands: [...(result.commands ?? []), ...(refreshed.commands ?? [])],
        },
        restoreKey(message.id, model.recovery.batchId),
      );
    },
    OpenedCompose: () => {
      const from = composeSender(model);
      return from
        ? foldCompose(model, Compose.Message.Opened({ from }))
        : { model };
    },
    GotComposeMessage: ({ message }) => {
      const result = foldCompose(model, message);
      if (
        message._tag === "SendFailed" &&
        model.compose.request === message.request
      )
        return notify(result, {
          key: "mail-compose",
          variant: "Error",
          title: message.error,
        });
      if (message._tag !== "Sent" || model.compose.request !== message.request)
        return result;
      const original = model.compose.reply?.originalId;
      const showReply = Boolean(
        original &&
        (original === model.selected ||
          model.thread?.messages.some(({ id }) => id === original)),
      );
      return sent(
        afterSend(result, message, showReply),
        "mail-compose",
        message,
      );
    },
    GotQuickReplyMessage: ({ message }) => {
      const result = foldQuickReply(model, message);
      if (
        message._tag === "Failed" &&
        model.quickReply.request === message.request
      )
        return notify(result, {
          key: "mail-reply",
          variant: "Error",
          title: message.error,
        });
      return message._tag === "Sent" &&
        message.request === model.quickReply.request
        ? sent(
            afterSend(
              result,
              message,
              model.quickReply.anchor === model.selected,
            ),
            "mail-reply",
            message,
          )
        : result;
    },
    LiveChanged: (change) => catchUp(model, change),
    RequestedMore: ({ folder, cursor }) =>
      isListVisible(model) &&
      model.folder === folder &&
      model.list?.cursor === cursor &&
      !model.list.indexing &&
      !model.listError
        ? loadList(model, cursor)
        : { model },
    RetriedEntry: () => loadEntry(model),
    RetriedThread: () => refreshThread(model),
    UpdatedProfiles: () =>
      withThread(model.folder !== "sent" ? refreshList(model) : { model }),
    ActivatedNotification: ({ action }) => {
      if (action._tag !== "RestoreMail") return { model };
      if (model.recovery.request)
        return notify(
          { model },
          {
            key: restoreKey(action.id, action.batchId),
            variant: "Info",
            title:
              "Another restore is still running. Try Undo again when it finishes.",
            action,
            description: action.subject,
          },
        );
      return foldRecovery(
        model,
        Recovery.Message.Restore({
          id: action.id,
          subject: action.subject,
          ...(action.batchId ? { batchId: action.batchId } : {}),
        }),
      );
    },
    ArchiveChanged: ({ request }) => {
      const change = model.archiveRequest;
      if (!change || request !== change.request) return { model };
      const removesRow = change.archived
        ? isInboxView(model.folder)
        : model.folder === "archive";
      const list =
        model.list && removesRow
          ? {
              ...model.list,
              messages: model.list.messages.filter(
                ({ id }) => id !== change.id,
              ),
            }
          : model.list;
      const next = {
        ...model,
        list,
        listRequest: null,
        threadRequest: null,
        archiveRequest: null,
      };
      return dismissNotification(
        withUnread(
          withThread(
            model.folder !== "sent" ? loadList(next, null) : { model: next },
          ),
        ),
        archiveKey(change.id),
      );
    },
    ArchiveFailed: ({ request, error }) => {
      const change = model.archiveRequest;
      if (request !== change?.request) return { model };
      return notify(
        withThread(refreshList({ ...model, archiveRequest: null })),
        {
          key: archiveKey(change.id),
          description: change.subject,
          variant: "Error",
          title: error,
        },
      );
    },
    AvatarMounted: () => ({ model }),
    SenderRuleSaved: ({ request }) => {
      const change = model.senderRuleRequest;
      if (change?.request !== request) return { model };
      const thread =
        model.thread?.senderRule?.address === change.address
          ? {
              ...model.thread,
              senderRule: {
                address: change.address,
                priority: change.priority,
              },
            }
          : model.thread;
      return dismissNotification(
        withThread(refreshList({ ...model, thread, senderRuleRequest: null })),
        priorityKey(change.address),
      );
    },
    SenderRuleFailed: ({ request }) => {
      const change = model.senderRuleRequest;
      if (change?.request !== request) return { model };
      return notify(
        { model: { ...model, senderRuleRequest: null } },
        {
          key: priorityKey(change.address),
          variant: "Error",
          title: "Could not update sender priority. Try again.",
          description: change.address,
        },
      );
    },
    ToggledMessage: ({ id, folder }) =>
      selectMessage(model, model.active?.id === id ? null : { id, folder }),
    RevealedMiddle: ({ firstMessageId }) => ({
      model: { ...model, middleRevealed: true },
      commands: [FocusMessageSummary({ id: firstMessageId })],
    }),
    RequestedBack: () => ({ model }),
    RequestedPerson: () => ({ model }),
    RequestedReply: () => {
      const from = model.list?.sender;
      const entry = model.entry;
      if (!from || !entry || !("receivedAt" in entry) || !entry.reply)
        return { model };
      return foldCompose(
        model,
        Compose.Message.OpenedReply({
          from,
          reply: {
            to: entry.reply.to,
            threaded: entry.reply.threaded,
            originalId: entry.id,
            subject: replySubject(entry.subject),
            text: quoteMessage(entry),
          },
        }),
      );
    },
    RequestedReplyAll: () => {
      const from = model.list?.sender;
      const entry = model.entry;
      if (!from || !entry || !("receivedAt" in entry) || !entry.reply)
        return { model };
      return foldCompose(
        model,
        Compose.Message.OpenedReply({
          from,
          reply: {
            originalId: entry.id,
            mode: "reply-all",
            threaded: entry.reply.threaded,
            to: entry.reply.allTo || entry.reply.cc || "",
            cc: entry.reply.allTo ? (entry.reply.cc ?? "") : "",
            subject: replySubject(entry.subject),
            text: quoteMessage(entry),
          },
        }),
      );
    },
    RequestedForward: () => {
      const from = model.list?.sender;
      const entry = model.entry;
      if (!from || !entry) return { model };
      const subject = /^fwd?:/iu.test(entry.subject)
        ? entry.subject
        : `Fwd: ${entry.subject}`;
      return foldCompose(
        model,
        Compose.Message.OpenedReply({
          from,
          reply: {
            originalId: entry.id,
            mode: "forward",
            threaded: false,
            to: "",
            subject: subject
              .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
              .slice(0, inboxComposeLimits.subject)
              .replace(/[\uD800-\uDBFF]$/u, ""),
            text: `\n\n---------- Forwarded message ----------\nFrom: ${entry.from}\nTo: ${entry.to}\nSubject: ${entry.subject}\nDate: ${new Date("receivedAt" in entry ? entry.receivedAt : entry.sentAt).toISOString()}${quoteMessage(entry)}`,
            forwarded: entry.attachments ?? [],
          },
        }),
      );
    },
    DownloadStarted: () => ({ model }),
    RequestedMessageDelete: ({ id }) => {
      const { active, entry } = model;
      if (active?.id !== id || model.deleteRequest || model.folder === "trash")
        return { model };
      const deletion = {
        ...active,
        subject:
          model.thread?.messages.find((message) => message.id === id)
            ?.subject ||
          (entry?.id === id ? entry.subject : undefined) ||
          "(no subject)",
        request: crypto.randomUUID(),
      };
      return {
        model: { ...model, deleteRequest: deletion },
        commands: [DeleteEntry(deletion)],
      };
    },
    DeletedEntry: ({ id, request, conversation }) => {
      const deletion = model.deleteRequest;
      if (
        request !== deletion?.request ||
        id !== deletion.id ||
        Boolean(deletion.conversationView) !== Boolean(conversation)
      )
        return { model };
      const removed = new Set(
        model.folder === "trash" ? [] : (conversation?.ids ?? [id]),
      );
      const selectedRemoved =
        model.selected !== null && removed.has(model.selected);
      const list = model.list && {
        ...model.list,
        messages: model.list.messages.filter(
          (message) => !removed.has(message.id),
        ),
      };
      const thread = model.thread && {
        ...model.thread,
        messages: model.thread.messages.filter(
          (message) => !removed.has(message.id),
        ),
      };
      const next: Model = {
        ...model,
        list,
        thread,
        threadRequest: null,
        listRequest: null,
        deleteRequest: null,
        ...(model.active && removed.has(model.active.id)
          ? {
              messageMenu: initial.messageMenu,
              active:
                model.selected && !selectedRemoved
                  ? {
                      id: model.selected,
                      folder: messageFolder(model.selected),
                    }
                  : null,
              entry: null,
              entryRequest: null,
              entryError: null,
              imageRequest: null,
              imageError: false,
              showPlainText: false,
              attachmentPreview: Attachments.initial,
              attachmentPopover: Popover.init({ id: "mail-attachments" }),
            }
          : {}),
      };
      const entry = next.entry ? { model: next } : loadEntry(next);
      const updatedList = loadList(entry.model, null);
      const command = {
        model: updatedList.model,
        commands: [...(entry.commands ?? []), ...(updatedList.commands ?? [])],
      };
      // Overlapping reads may have received a snapshot from before the deletion.
      return notify(
        withUnread(selectedRemoved ? command : withThread(command)),
        {
          key: restoreKey(id, conversation?.batchId),
          variant: "Success",
          title: conversation ? "Conversation deleted." : "Email deleted.",
          description: deletion.subject,
          durationMs: 10_000,
          action: Action.RestoreMail({
            id,
            subject: deletion.subject,
            ...(conversation ? { batchId: conversation.batchId } : {}),
          }),
        },
      );
    },
    DeleteFailed: ({ request }) =>
      request !== model.deleteRequest?.request
        ? { model }
        : notify(
            { model: { ...model, deleteRequest: null } },
            {
              key: deleteKey(
                model.deleteRequest.id,
                Boolean(model.deleteRequest.conversationView),
              ),
              description: model.deleteRequest.subject,
              variant: "Error",
              title:
                "Could not confirm the deletion. Check Trash before trying again.",
            },
          ),
    GotEmptyTrashDialogMessage: ({ message }) => {
      if (
        (message._tag === "RequestedOpen" &&
          (!canEmptyTrash(model) || model.emptyTrashRequest)) ||
        (message._tag === "RequestedClose" && model.emptyTrashRequest)
      )
        return { model };
      const result = foldEmptyTrashDialog(model, message);
      return message._tag === "CompletedCloseDialog" &&
        model.folder === "trash" &&
        !canEmptyTrash(model)
        ? {
            ...result,
            commands: [
              ...(result.commands ?? []),
              RecoverRowFocus({ folder: "trash", neighborId: null }),
            ],
          }
        : result;
    },
    ConfirmedEmptyTrash: () => {
      if (!model.emptyTrashDialog.isOpen || model.emptyTrashRequest)
        return { model };
      const request = crypto.randomUUID();
      return {
        model: { ...model, emptyTrashRequest: request, emptyTrashError: null },
        commands: [EmptyTrash({ request })],
      };
    },
    EmptiedTrash: ({ request }) => {
      if (request !== model.emptyTrashRequest) return { model };
      const next = { ...model, emptyTrashRequest: null, emptyTrashError: null };
      const closed = foldEmptyTrashDialog(
        next,
        Dialog.Message.RequestedClose(),
      );
      const refreshed =
        model.folder === "trash"
          ? loadList(
              {
                ...closed.model,
                rowActions,
                list: model.list && {
                  ...model.list,
                  messages: [],
                  cursor: null,
                },
                listRequest: null,
              },
              null,
            )
          : { model: closed.model };
      return notify(
        {
          model: refreshed.model,
          commands: [...(closed.commands ?? []), ...(refreshed.commands ?? [])],
        },
        {
          key: "mail-empty-trash",
          variant: "Success",
          title: "Trash emptied.",
        },
      );
    },
    EmptyTrashFailed: ({ request }) => {
      if (request !== model.emptyTrashRequest) return { model };
      const error = "Could not finish emptying Trash. Try again.";
      const result = {
        model: { ...model, emptyTrashRequest: null, emptyTrashError: error },
      };
      return model.emptyTrashDialog.isOpen
        ? result
        : notify(result, {
            key: "mail-empty-trash",
            variant: "Error",
            title: error,
          });
    },
    LoadedList: ({ request, page }) => {
      if (request !== model.listRequest?.id) return { model };
      const { cursor } = model.listRequest;
      let list = page;
      if (cursor !== null && model.list) {
        const loadedIds = new Set(page.messages.map(({ id }) => id));
        const messages = [
          ...model.list.messages.filter(({ id }) => !loadedIds.has(id)),
          ...page.messages,
        ];
        if (supportsMailFilters(model.folder)) messages.sort(compareRows);
        list = { ...page, messages };
      }
      const next = {
        ...model,
        listRequest: null,
        list: retainThreadRow({ ...model, list }),
      };
      const result =
        next.listRefreshQueued || page.indexing
          ? loadList(next, null)
          : { model: next };
      return page.indexing || model.list?.indexing
        ? withThread(result)
        : result;
    },
    ListFailed: ({ request }) => {
      if (request !== model.listRequest?.id) return { model };
      const { cursor } = model.listRequest;
      const next = {
        ...model,
        listRequest: null,
        listError: {
          cursor,
          message:
            cursor === null
              ? "Could not load messages. Try again."
              : "Could not load more messages. Try again.",
        },
      };
      return next.listRefreshQueued ? loadList(next, null) : { model: next };
    },
    LoadedUnread: (message) => finishUnread(model, message.request, message),
    UnreadFailed: ({ request }) => finishUnread(model, request),
    UpdatedReadStatus: ({ request, id, status }) => {
      const change = model.readRequests[id];
      if (change?.request !== request) return { model };
      const next = reconcileReadStatus(finishReadStatus(model, id), id, status);
      const updated =
        status.changed && status.version > next.liveVersion
          ? advanceLiveVersion(
              {
                ...next,
                localReadVersions: [...next.localReadVersions, status.version],
              },
              next.liveVersion,
            )
          : next;
      const overlapping = restartOverlappingReads({ model: updated });
      const result = completeRead(overlapping.model);
      // Reopening can resolve an earlier explicit failure without a manual retry.
      return dismissNotification(
        {
          ...result,
          commands: [
            ...(overlapping.commands ?? []),
            ...(result.commands ?? []),
          ],
        },
        readKey(id),
      );
    },
    ReadStatusFailed: ({ request, id }) => {
      const change = model.readRequests[id];
      if (change?.request !== request) return { model };
      const next = finishReadStatus(model, id);
      // Opening an unread message marks it read automatically; keep that failure in context.
      if (!change.userInitiated)
        return completeRead({ ...next, readFailed: id });
      return notify(completeRead(next), {
        key: readKey(id),
        variant: "Error",
        title: `Could not mark email ${change.unread ? "unread" : "read"}. Try again.`,
        description: change.subject,
      });
    },
    LoadedThread: ({ request, thread }) => {
      if (request !== model.threadRequest) return { model };
      const newestIncoming = thread.messages.findLast(
        ({ folder }) => folder === "inbox",
      );
      const latest =
        !model.thread &&
        !model.entry &&
        !model.entryRequest &&
        !model.focusMessage &&
        model.folder !== "sent" &&
        model.selected === newestIncoming?.id
          ? thread.messages.at(-1)
          : undefined;
      const next = {
        ...model,
        thread,
        threadRequest: null,
        ...(latest ? { active: { id: latest.id, folder: latest.folder } } : {}),
      };
      const entry =
        next.entry || next.entryError ? { model: next } : loadEntry(next);
      return next.threadRefreshQueued ? withThread(entry) : entry;
    },
    ThreadFailed: ({ request }) => {
      if (request !== model.threadRequest) return { model };
      const next = { ...model, threadRequest: null, threadFailed: true };
      const entry =
        next.entry || next.entryError ? { model: next } : loadEntry(next);
      return next.threadRefreshQueued ? withThread(entry) : entry;
    },
    LoadedEntry: ({ request, entry }) => {
      if (request !== model.entryRequest) return { model };
      const next = {
        ...model,
        entry,
        entryRequest: null,
        imageRequest: null,
        imageError: false,
      };
      const read =
        model.folder !== "trash" && "receivedAt" in entry && entry.unread
          ? setUnread(next, [entry.id], false)
          : { model: next };
      const images = entry.remoteImages?.available
        ? loadImages(read.model)
        : { model: read.model };
      return {
        model: images.model,
        commands: [...(read.commands ?? []), ...(images.commands ?? [])],
      };
    },
    LoadedImages: ({ request, id, html, remoteImages }) =>
      request === model.imageRequest && model.entry?.id === id
        ? {
            model: {
              ...model,
              entry: { ...model.entry, html, remoteImages },
              imageRequest: null,
              imageError: false,
            },
          }
        : { model },
    ImagesFailed: ({ request }) =>
      request === model.imageRequest
        ? { model: { ...model, imageRequest: null, imageError: true } }
        : { model },
    EntryFailed: ({ request, missing }) =>
      request !== model.entryRequest
        ? { model }
        : {
            model: {
              ...model,
              entryRequest: null,
              entryError: missing
                ? "This message is unavailable."
                : "Could not open this message.",
            },
          },
    SessionExpired: () => ({ model }),
    FocusUpdated: () => ({ model }),
  });

export const update = (model: Model, message: Message): Result => {
  const result = transition(model, message);
  const next = result.model;
  const row = next.rowActions.row;
  if (!row || !model.list || !next.list) return result;
  const remaining = new Set(visibleList(next)?.messages.map(({ id }) => id));
  if (remaining.has(row.key)) return result;
  const previous = visibleList(model)?.messages ?? [];
  const index = previous.findIndex(({ id }) => id === row.key);
  if (index === -1) return result;
  const neighbor =
    previous.slice(index + 1).find(({ id }) => remaining.has(id)) ??
    previous.slice(0, index).findLast(({ id }) => remaining.has(id));
  return {
    ...result,
    model: { ...next, rowActions },
    commands: [
      ...(result.commands ?? []),
      RecoverRowFocus({
        folder: next.folder,
        neighborId: neighbor?.id ?? null,
      }),
    ],
  };
};

const messageDateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const participantTooltip = (
  name: string,
  address: string,
  aliases: readonly string[],
) => [name, address, ...aliases].filter(Boolean).join("\n") || "Unknown sender";

const findProfiles = (matches: readonly PersonMatch[] | undefined) =>
  new Map(matches?.map(({ email, person }) => [email, person]));

const groupParticipants = (
  participants: readonly MailPerson[],
  profiles: ReadonlyMap<string, PersonSummary>,
) => {
  const groups = new Map<
    string,
    {
      addresses: [string, ...string[]];
      name: string;
      person: PersonSummary | undefined;
      appearance: MailPerson["appearance"];
    }
  >();
  for (const { address, name, appearance } of participants) {
    const email = normalizePersonEmail(address);
    const person = profiles.get(email);
    const key = person?.id ?? email;
    const participant = groups.get(key);
    if (participant) {
      participant.addresses.push(address);
      if (!participant.appearance && appearance)
        participant.appearance = appearance;
    } else
      groups.set(key, {
        addresses: [address],
        name: person?.name || name,
        person,
        appearance,
      });
  }
  return [...groups];
};

const messageItem = (
  model: Model,
  message: NonNullable<Model["list"]>["messages"][number],
  now: number,
  h: HtmlBuilder<Message>,
) => {
  const sent = "sentAt" in message;
  const subject = sent
    ? message.subject || "(No subject)"
    : conversationSubject([message]);
  const people = sent
    ? [{ address: message.to, name: "" }]
    : (message.senders ?? message.participants);
  const profiles = findProfiles(sent ? undefined : message.profiles);
  const participants = groupParticipants(
    people.length ? people : [{ address: message.from, name: "" }],
    profiles,
  );
  const lead = (!sent && message.avatarSender) ||
    people[0] || { address: message.from, name: "" };
  const leadProfile = profiles.get(normalizePersonEmail(lead.address));
  const unread = !sent && message.unreadCount > 0;
  const current =
    model.selected === message.id ||
    (model.folder !== "sent" &&
      model.thread?.messages.some(({ id }) => id === message.id));
  const date = timestamp(
    sent ? message.sentAt : message.lastMessageAt,
    now,
    h,
    formatMailTimestamp,
  );
  const actions = sent
    ? []
    : withActionIcons(rowActionItems(model, message), h);
  return item(
    {
      key: message.id,
      href: selectedMailboxUrl(mailMessagePage(model.folder, message.id)),
      linkTitleOnly: true,
      title: subject,
      attributes: actions.length
        ? ItemActionMenu.rowAttributes(message.id, toRowMenuMessage, h)
        : [],
      media: h.span(
        [h.Class("inbox-list-avatar")],
        [
          profileAvatar(h, {
            address: lead.address,
            person: leadProfile,
            name: leadProfile?.name || lead.name,
            appearance: lead.appearance,
            editLabel: `Edit profile for ${lead.address}`,
            canLinkSender: model.folder === "noise",
          }),
        ],
      ),
      linkAttributes: [
        h.DataAttribute("message-id", message.id),
        ...(actions.length
          ? ItemActionMenu.rowLinkAttributes(
              rowActions.id,
              message.id,
              actions,
              toRowMenuMessage,
              h,
            )
          : []),
        ...(current ? [h.AriaCurrent("page")] : []),
        ...(unread
          ? [h.DataAttribute("unread", ""), h.AriaLabel(`Unread: ${subject}`)]
          : []),
      ],
      action:
        actions.length === 0
          ? date
          : h.div(
              [h.Class("inbox-row-actions")],
              [
                date,
                rowMenu.view(
                  {
                    model: model.rowActions,
                    rowKey: message.id,
                    label: `Actions for ${subject}`,
                    items: actions,
                    toParentMessage: toRowMenuMessage,
                  },
                  h,
                ),
              ],
            ),
      description: h.div(
        [h.Class("inbox-item-details")],
        [
          h.div(
            [h.Class("inbox-item-preview")],
            [
              h.span(
                [h.Class("inbox-preview-text")],
                [message.bodyPreview ?? ""],
              ),
            ],
          ),
          ...(participants.length > 1
            ? [
                h.div(
                  [h.Class("inbox-item-summary")],
                  [
                    avatarGroup(
                      participants.map(
                        ([
                          key,
                          {
                            addresses: [address, ...aliases],
                            name,
                            person,
                            appearance,
                          },
                        ]) => ({
                          key,
                          label:
                            sent && !address
                              ? "Unknown recipient"
                              : participantTooltip(name, address, aliases),
                          picture: profileAvatar(h, {
                            address,
                            person,
                            name,
                            aliases,
                            appearance,
                            editLabel: `Edit participant profile for ${address}`,
                          }),
                        }),
                      ),
                      h,
                      "Participant profiles",
                      5,
                    ),
                  ],
                ),
              ]
            : []),
        ],
      ),
    },
    h,
  );
};

const inboxPrioritySwitch = (selected: MailboxView, h: HtmlBuilder<Message>) =>
  navigationLinks(
    {
      label: "Inbox priority",
      variant: "pills",
      destinations: (["inbox", "noise"] as const).map((folder) => ({
        href: selectedMailboxUrl(folderPath(folder)),
        label: folder === "inbox" ? "Signal" : "Noise",
        current: folder === selected,
      })),
    },
    h,
  );

const listFailure = (message: string, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("inbox-status")],
    [
      h.p([h.Role("alert")], [message]),
      h.button([h.Type("button"), h.OnClick(Message.RetriedList())], ["Retry"]),
    ],
  );

const filteredEmpty = (h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("inbox-status")],
    [
      h.p([h.Role("status")], ["No conversations match your filters."]),
      button(
        {
          size: "sm",
          variant: "outline",
          onClick: toFiltersMessage(Filters.Message.Cleared()),
          children: ["Clear filters"],
        },
        h,
      ),
    ],
  );

const emptyTrashDialog = (model: Model, h: HtmlBuilder<Message>) => {
  const pending = model.emptyTrashRequest !== null;
  return Dialog.view(
    {
      model: model.emptyTrashDialog,
      title: "Empty Trash?",
      alertDescription:
        "All messages in Trash and their attachments will be permanently deleted.",
      toParentMessage: toEmptyTrashDialogMessage,
      content: (initialFocus) =>
        h.div(
          [],
          [
            alert(
              {
                message: model.emptyTrashError,
                severity: "error",
                announcement: "alert",
              },
              h,
            ),
            Dialog.footer(
              [
                button(
                  {
                    variant: "outline",
                    disabled: pending,
                    attributes: initialFocus,
                    onClick: toEmptyTrashDialogMessage(
                      Dialog.Message.RequestedClose(),
                    ),
                    children: ["Cancel"],
                  },
                  h,
                ),
                button(
                  {
                    variant: "destructive",
                    disabled: pending,
                    focusableWhenDisabled: true,
                    attributes: [h.AriaBusy(pending)],
                    onClick: Message.ConfirmedEmptyTrash(),
                    children: [pending ? "Emptying Trash…" : "Empty trash"],
                  },
                  h,
                ),
              ],
              h,
            ),
          ],
        ),
    },
    h,
  );
};

const listView = (model: Model, h: HtmlBuilder<Message>) => {
  const now = Date.now();
  const { list, listRequest, listError, folder, selected } = model;
  const visible = isListVisible(model);
  return h.section(
    [
      h.Class("workspace-list inbox-list"),
      h.DataAttribute("folder", folder),
      h.AriaLabel("Messages"),
      h.Inert(!visible),
      h.Tabindex(-1),
      h.OnUnmount(Message.UnmountedList()),
    ],
    [
      h.div(
        [h.Key(folder), h.Class("workspace-results")],
        [
          ...(listError?.cursor === null
            ? [listFailure(listError.message, h)]
            : []),
          ...(list?.indexing
            ? [
                h.p(
                  [h.Class("inbox-status"), h.Role("status")],
                  ["Organizing existing mail…"],
                ),
              ]
            : []),
          ...(list === null
            ? []
            : [
                list.messages.length === 0 &&
                list.cursor === null &&
                !list.indexing
                  ? supportsMailFilters(folder) &&
                    mailFilterCount(model.filters.selection)
                    ? filteredEmpty(h)
                    : h.p(
                        [h.Class("inbox-status")],
                        [
                          folder === "trash"
                            ? "Trash is empty."
                            : folder === "archive"
                              ? "No archived conversations."
                              : isInboxView(folder)
                                ? `No ${folder === "noise" ? "noise" : "signal"} conversations.`
                                : "No messages yet.",
                        ],
                      )
                  : itemGroup(
                      list.messages.map((message) =>
                        messageItem(model, message, now, h),
                      ),
                      h,
                    ),
                ...(listError?.cursor != null
                  ? [listFailure(listError.message, h)]
                  : []),
                ...(list.cursor &&
                !list.indexing &&
                !listRequest &&
                !listError &&
                visible
                  ? [
                      h.div(
                        [
                          h.Key(`inbox-list-end-${list.cursor}`),
                          h.Class("inbox-list-end"),
                          h.AriaHidden(true),
                          h.OnMount(
                            ObserveListEnd({ folder, cursor: list.cursor }),
                          ),
                        ],
                        [],
                      ),
                    ]
                  : []),
              ]),
        ],
      ),
      ...(folder === "trash" && selected === null
        ? [emptyTrashDialog(model, h)]
        : []),
    ],
  );
};

const previewNotice = {
  truncated: "This preview is shortened.",
  tooLarge: "This message is too large to preview.",
  unreadable: "This message could not be previewed.",
};

const entryContent = (model: Model, h: HtmlBuilder<Message>) => {
  const { entry } = model;
  const html = !model.showPlainText ? entry?.html : undefined;
  return [
    ...(entry && model.readFailed === entry.id
      ? [h.p([h.Role("alert")], ["Could not update read status. Try again."])]
      : []),
    ...(model.entryRequest
      ? [h.p([h.Role("status")], ["Opening message…"])]
      : []),
    ...(model.entryError
      ? [
          h.p([h.Role("alert")], [model.entryError]),
          h.button(
            [h.Type("button"), h.OnClick(Message.RetriedEntry())],
            ["Retry"],
          ),
        ]
      : []),
    ...(entry
      ? [
          ...(html
            ? [
                h.iframe([
                  h.Key(`html-${entry.id}`),
                  h.Class("inbox-html"),
                  h.Title("Email message"),
                  h.Sandbox(mailHtmlSandbox),
                  h.Referrerpolicy("no-referrer"),
                  h.Srcdoc(mailHtmlDocument(html)),
                ]),
                ...(model.imageRequest
                  ? [
                      h.p(
                        [h.Class("inbox-preview"), h.Role("status")],
                        ["Loading images…"],
                      ),
                    ]
                  : model.imageError || entry.remoteImages?.unavailable
                    ? [
                        h.p(
                          [h.Class("inbox-preview")],
                          ["Some images could not be loaded."],
                        ),
                      ]
                    : []),
              ]
            : []),
          ...(!html && entry.text
            ? [
                h.div(
                  [h.Class("inbox-body")],
                  [
                    ...splitMailQuote(entry.text).map(
                      ({ text, quoted }, index) =>
                        quoted
                          ? h.details(
                              [h.Key(String(index)), h.Class("inbox-quote")],
                              [
                                h.summary(
                                  [
                                    h.DataAttribute("slot", "button"),
                                    h.AriaLabel("Quoted text"),
                                    h.Title("Quoted text"),
                                    h.Class(
                                      buttonClassName({
                                        variant: "ghost",
                                        size: "icon-sm",
                                      }),
                                    ),
                                  ],
                                  [ellipsisIcon(h)],
                                ),
                                h.blockquote([], [text]),
                              ],
                            )
                          : h.div(
                              [
                                h.Key(String(index)),
                                h.Class("inbox-body-part"),
                              ],
                              [text],
                            ),
                    ),
                  ],
                ),
              ]
            : []),
          ...(entry.preview !== "complete" || (!entry.text && !html)
            ? [
                h.p(
                  [h.Class("inbox-preview")],
                  [
                    entry.preview === "complete"
                      ? "This message has no text body."
                      : previewNotice[entry.preview],
                  ],
                ),
              ]
            : []),
          ...(entry.attachments?.length
            ? [
                h.submodel({
                  slotId: `inbox-attachments-${entry.id}`,
                  view: Attachments.previewView,
                  model: {
                    id: entry.id,
                    attachments: entry.attachments,
                    state: model.attachmentPreview,
                    trash: model.folder === "trash",
                  },
                  toParentMessage: toAttachmentMessage,
                }),
              ]
            : []),
        ]
      : []),
  ];
};

const readerMessages = (model: Model): readonly ConversationMessage[] => {
  const messages = model.thread?.messages ?? [];
  const { entry, active } = model;
  if (!entry || !active) return messages;
  if (messages.some(({ id }) => id === entry.id))
    return messages.map((message) =>
      message.id === entry.id && entry.people
        ? { ...message, people: entry.people }
        : message,
    );
  return [
    ...messages,
    {
      id: entry.id,
      folder: active.folder,
      from: entry.from,
      to: entry.to,
      subject: entry.subject,
      timestamp: "sentAt" in entry ? entry.sentAt : entry.receivedAt,
      ...("receivedAt" in entry && entry.unread !== undefined
        ? { unread: entry.unread }
        : {}),
      ...(entry.people ? { people: entry.people } : {}),
    },
  ].sort((a, b) => a.timestamp - b.timestamp);
};

const profileAvatar = (
  h: HtmlBuilder<Message>,
  {
    address,
    person,
    name,
    aliases = [],
    appearance,
    editLabel,
    canLinkSender,
  }: {
    address: string;
    person: PersonSummary | undefined;
    name: string;
    aliases?: readonly string[];
    appearance?: MailPerson["appearance"];
    editLabel: string;
    canLinkSender?: boolean;
  },
) => {
  const tooltip = participantTooltip(name, address, aliases);
  const picture = mailAvatar(
    h,
    person,
    { address, name, ...(appearance ? { appearance } : {}) },
    Message.AvatarMounted(),
  );
  return isPersonEmail(address)
    ? h.button(
        [
          h.Type("button"),
          h.DataAttribute("slot", "button"),
          h.Class("inbox-profile-avatar"),
          h.Title(tooltip),
          h.AriaLabel(editLabel),
          h.AriaHasPopup("dialog"),
          h.AriaControls(personDialogId),
          h.OnClick(
            Message.RequestedPerson({
              address,
              name,
              ...(canLinkSender ? { canLinkSender } : {}),
              ...(!person && appearance?.kind === "service"
                ? {
                    suggestedCompany: true,
                    ...(appearance.domain
                      ? { suggestedDomain: appearance.domain }
                      : {}),
                  }
                : {}),
            }),
          ),
        ],
        [picture],
      )
    : h.span(
        [
          h.Class("inbox-profile-avatar"),
          h.Title(tooltip),
          h.Role("img"),
          h.AriaLabel(tooltip),
        ],
        [picture],
      );
};

const mailIcon = (h: HtmlBuilder<Message>, path: string) =>
  h.svg(
    [
      h.ViewBox("0 0 24 24"),
      h.Width("16"),
      h.Height("16"),
      h.Fill("none"),
      h.Stroke("currentColor"),
      h.StrokeWidth("2"),
      h.StrokeLinecap("round"),
      h.StrokeLinejoin("round"),
      h.AriaHidden(true),
    ],
    [h.path([h.D(path)], [])],
  );

const restoreIconPath = "M9 14 4 9l5-5M4 9h10a5 5 0 0 1 0 10";
const readIconPath = "M3 5h18v14H3zM3 6l9 7 9-7";

type ActionItem<Action extends string> = Omit<
  DropdownMenu.Item<Action>,
  "icon"
> & {
  path: string;
};

const withActionIcons = <Action extends string>(
  items: readonly ActionItem<Action>[],
  h: HtmlBuilder<Message>,
): DropdownMenu.Item<Action>[] =>
  items.map(({ path, ...item }) => ({ ...item, icon: mailIcon(h, path) }));

const archiveItem = (
  archived: boolean,
  disabled: boolean,
): ActionItem<"archive"> => ({
  action: "archive",
  label: archived ? "Move to Inbox" : "Mark done",
  path: archived ? restoreIconPath : "m5 12 4 4L19 6",
  disabled,
});

const senderPriorityItems = (
  rule: typeof SenderRule.Type | undefined,
  pending: boolean,
): ActionItem<typeof SenderPriority.Type>[] => {
  if (!rule) return [];
  const items: ActionItem<typeof SenderPriority.Type>[] = [
    {
      action: "signal",
      label: "Sender → Signal",
      disabled: pending || rule.priority === "signal",
      path: "M2 12c2-6 4-6 6 0s4 6 6 0 4-6 6 0",
    },
    {
      action: "noise",
      label: "Sender → Noise",
      disabled: pending || rule.priority === "noise",
      path: noiseIconPath,
    },
  ];
  if (rule.priority !== "automatic")
    items.push({
      action: "automatic",
      label: "Sender → Automatic",
      disabled: pending,
      path: "M3 12a9 9 0 1 1 2.7 6.4M3 12V5m0 7h7",
    });
  return items;
};

const rowActionItems = (
  model: Model,
  row: typeof ConversationSummary.Type,
): ActionItem<RowAction>[] => {
  if (model.folder === "sent") return [];
  if (model.folder === "trash")
    return [
      {
        action: "restore",
        label: row.trashBatch ? "Restore conversation" : "Restore message",
        path: restoreIconPath,
        disabled: model.recovery.request !== null,
      },
    ];
  const items: ActionItem<RowAction>[] = [];
  const readTargets = rowReadTargets(row);
  if (readTargets.length)
    items.push({
      action: "toggleUnread",
      label: row.unreadCount ? "Mark read" : "Mark unread",
      path: readIconPath,
      disabled: Object.entries(model.readRequests).some(
        ([id, change]) =>
          change.latestIncomingId === row.latestIncomingId ||
          readTargets.includes(id),
      ),
    });
  if (row.latestIncomingId)
    items.push(archiveItem(row.archived, model.archiveRequest !== null));
  items.push(
    ...senderPriorityItems(row.senderRule, model.senderRuleRequest !== null),
    {
      action: "delete",
      label: "Delete conversation",
      path: trashIconPaths.join(" "),
      disabled: model.deleteRequest !== null,
      destructive: true,
    },
  );
  return items;
};

const conversationActions = (model: Model, h: HtmlBuilder<Message>) => {
  if (model.folder === "trash") return h.empty;
  const canArchive =
    model.folder !== "sent" &&
    model.thread?.messages.some(({ folder }) => folder === "inbox");
  const items = withActionIcons<ConversationAction>(
    [
      ...(canArchive
        ? [archiveItem(Boolean(model.thread?.archived), false)]
        : []),
      ...senderPriorityItems(
        model.thread?.senderRule,
        model.senderRuleRequest !== null,
      ),
    ],
    h,
  );
  if (items.length === 0) return h.empty;
  return conversationMenu.view(
    {
      model: model.conversationMenu,
      label: "Conversation actions",
      disabled: model.archiveRequest !== null,
      toParentMessage: toConversationMenuMessage,
      trigger: ellipsisIcon(h),
      items,
    },
    h,
  );
};

const attachmentActions = (model: Model, h: HtmlBuilder<Message>) => {
  const entry = model.entry;
  if (!entry?.attachments?.length || entry.id !== model.active?.id)
    return h.empty;
  const count = entry.attachments.length;
  return Popover.view(
    {
      model: model.attachmentPopover,
      label: `Attachments (${count})`,
      trigger: mailIcon(
        h,
        "m21 11-9 9a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.5-8.5",
      ),
      content: h.submodel({
        slotId: `inbox-attachment-list-${entry.id}`,
        view: Attachments.listView,
        model: {
          id: entry.id,
          attachments: entry.attachments,
          trash: model.folder === "trash",
        },
        toParentMessage: toAttachmentMessage,
      }),
      toParentMessage: toAttachmentPopoverMessage,
    },
    h,
  );
};

const messageOverflow = (model: Model, h: HtmlBuilder<Message>) => {
  const { active, entry } = model;
  if (!active) return h.empty;
  const items: DropdownMenu.Item<MessageAction>[] = [];

  if (entry?.id === active.id && entry.html) {
    items.push({
      action: "togglePlainText",
      icon: mailIcon(h, "M4 5h16M4 10h16M4 15h10M4 20h10"),
      label: model.showPlainText ? "Show formatted email" : "Show plain text",
    });
    if (entry.remoteImages?.blocked)
      items.push({
        action: "loadBlockedImages",
        icon: mailIcon(h, "M3 3h18v18H3zM3 16l5-5 4 4 4-6 5 7M7 7h.01"),
        label: "Load blocked images",
        disabled: model.imageRequest !== null,
      });
    if (model.imageError)
      items.push({
        action: "retryImages",
        icon: mailIcon(h, "M3 12a9 9 0 1 1 2.7 6.4M3 12V5m0 7h7"),
        label: "Retry loading images",
        disabled: model.imageRequest !== null,
      });
  }
  if (active.folder === "inbox") {
    if (
      model.folder !== "trash" &&
      entry?.id === active.id &&
      "receivedAt" in entry
    ) {
      items.push({
        action: "toggleUnread",
        label: entryUnread(model) ? "Mark read" : "Mark unread",
        disabled: Boolean(model.readRequests[entry.id]),
        icon: mailIcon(h, readIconPath),
      });
    }
    items.push({
      action: "download",
      label: "Download .eml",
      icon: mailIcon(
        h,
        "M12 3v12m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4",
      ),
    });
  }
  if (model.folder === "trash")
    items.push({
      action: "restore",
      label:
        model.recovery.restoring === active.id
          ? "Restoring…"
          : "Restore message",
      disabled: model.recovery.request !== null,
      icon: mailIcon(h, restoreIconPath),
    });
  if (!items.length) return h.empty;
  return messageMenu.view(
    {
      model: model.messageMenu,
      label: "Message actions",
      toParentMessage: toMessageMenuMessage,
      trigger: ellipsisIcon(h),
      items,
    },
    h,
  );
};

const messageHeaderActions = (model: Model, h: HtmlBuilder<Message>) => {
  const { active, entry } = model;
  if (!active) return h.empty;
  const inTrash = model.folder === "trash";
  const canForward = !inTrash && model.list?.sender && entry?.id === active.id;
  const canReply = canForward && "receivedAt" in entry && entry.reply;
  const composeAction = (
    label: string,
    paths: readonly string[],
    onClick: Message,
  ) =>
    button(
      {
        variant: "ghost",
        size: "icon-sm",
        ariaLabel: label,
        dialogId: Compose.dialogId,
        attributes: [h.Title(label)],
        onClick,
        children: [outlineIcon(h, paths)],
      },
      h,
    );

  return h.div(
    [h.Class("inbox-message-tools")],
    [
      attachmentActions(model, h),
      ...(canReply
        ? [
            composeAction(
              "Reply",
              ["m10 7-5 5 5 5", "M5 12h9a5 5 0 0 1 5 5v2"],
              Message.RequestedReply(),
            ),
            composeAction(
              "Reply all",
              ["M7 7l-5 5 5 5", "m12 7-5 5 5 5", "M7 12h9a5 5 0 0 1 5 5v2"],
              Message.RequestedReplyAll(),
            ),
          ]
        : []),
      ...(canForward
        ? [
            composeAction(
              "Forward",
              ["m14 7 5 5-5 5", "M19 12h-9a5 5 0 0 0-5 5v2"],
              Message.RequestedForward(),
            ),
          ]
        : []),
      ...(inTrash
        ? []
        : [
            button(
              {
                variant: "ghost",
                size: "icon-sm",
                ariaLabel: "Delete message",
                attributes: [
                  h.Title("Delete message"),
                  h.DataAttribute("message-delete", ""),
                ],
                disabled: model.deleteRequest !== null,
                onClick: Message.RequestedMessageDelete({ id: active.id }),
                children: [outlineIcon(h, trashIconPaths)],
              },
              h,
            ),
          ]),
      messageOverflow(model, h),
    ],
  );
};

const entryView = (
  model: Model,
  selected: NonNullable<Model["selected"]>,
  h: HtmlBuilder<Message>,
) => {
  const { active } = model;
  const now = Date.now();
  const messages = readerMessages(model);
  const participants = conversationPeople(messages);
  const profiles = findProfiles(model.thread?.profiles);
  const participantAvatars = groupParticipants(participants, profiles);
  const latest = messages.at(-1);
  const noiseSender =
    model.folder === "noise" ? model.thread?.senderRule?.address : undefined;
  const grouped = messages.length > 1;
  const middleCount = model.middleRevealed
    ? 0
    : collapsibleMiddleCount(messages, [
        selected,
        active?.id,
        model.quickReply.target,
        model.compose.reply?.originalId,
      ]);
  const firstHidden = middleCount > 0 ? messages[1]?.id : undefined;
  const content = h.div(
    [h.Class("inbox-reader-content")],
    [
      ...(!model.thread &&
      model.threadRequest &&
      !model.entryRequest &&
      !model.entry
        ? [h.p([h.Role("status")], ["Opening conversation…"])]
        : []),
      ...(model.threadFailed
        ? [
            h.p([h.Role("alert")], ["Could not load the conversation."]),
            h.button(
              [h.Type("button"), h.OnClick(Message.RetriedThread())],
              ["Retry conversation"],
            ),
          ]
        : []),
      ...(messages.length
        ? [
            h.header(
              [h.Class("inbox-conversation-heading")],
              [
                h.div(
                  [h.Class("inbox-conversation-title")],
                  [
                    h.h1([], [conversationSubject(messages)]),
                    conversationActions(model, h),
                  ],
                ),
                ...(participantAvatars.length
                  ? [
                      avatarGroup(
                        participantAvatars.map(
                          ([
                            key,
                            {
                              addresses: [address, ...aliases],
                              name,
                              person,
                              appearance,
                            },
                          ]) => ({
                            key,
                            label: participantTooltip(name, address, aliases),
                            picture: profileAvatar(h, {
                              address,
                              person,
                              name,
                              aliases,
                              appearance,
                              editLabel: `Edit participant profile for ${address}`,
                              canLinkSender:
                                normalizePersonEmail(address) === noiseSender,
                            }),
                          }),
                        ),
                        h,
                        "Participant profiles",
                      ),
                    ]
                  : []),
              ],
            ),
            h.ol(
              [h.Class("inbox-thread"), h.AriaLabel("Conversation messages")],
              messages.flatMap((message, index) => {
                if (index > 0 && index <= middleCount) return [];
                const {
                  id,
                  folder,
                  from,
                  timestamp: messageTime,
                  unread,
                } = message;
                const sender = message.people?.sender;
                const address = sender?.address || from;
                const person = profiles.get(normalizePersonEmail(address));
                const name = person?.name || sender?.name || "";
                const date = messageDateFormat.format(messageTime);
                const expanded = active?.id === id;
                const preview = expanded ? undefined : message.bodyPreview;
                const previewId = `mail-preview-${id}`;
                const row = itemDisclosure(
                  {
                    key: id,
                    variant: "outline",
                    media: profileAvatar(h, {
                      address,
                      person,
                      name,
                      appearance: sender?.appearance,
                      editLabel: `Edit profile for ${address}`,
                      canLinkSender:
                        model.folder === "noise" && folder === "inbox",
                    }),
                    summary: [
                      preview
                        ? h.span(
                            [h.Id(previewId), h.Class("inbox-message-preview")],
                            [preview],
                          )
                        : h.span(
                            [h.Class("inbox-message-sender")],
                            [name || address || "Unknown sender"],
                          ),
                      ...(unread
                        ? [h.span([h.Class("inbox-thread-unread")], ["Unread"])]
                        : []),
                    ],
                    trailing: [
                      ...(expanded ? [messageHeaderActions(model, h)] : []),
                      timestamp(messageTime, now, h, formatMailTimestamp),
                    ],
                    ...(grouped
                      ? {
                          toggle: {
                            label: `Message from ${address || "unknown sender"}, ${date}${unread ? ", unread" : ""}`,
                            onClick: Message.ToggledMessage({ id, folder }),
                            attributes: [
                              h.DataAttribute("thread-message-id", id),
                              ...(preview
                                ? [h.AriaDescribedBy(previewId)]
                                : []),
                            ],
                          },
                        }
                      : {}),
                    ...(expanded
                      ? { panel: h.div([], entryContent(model, h)) }
                      : {}),
                  },
                  h,
                );
                return index === 0 && firstHidden
                  ? [
                      row,
                      h.li(
                        [h.Key("thread-middle")],
                        [
                          marker(
                            {
                              label: `Show ${middleCount} hidden ${middleCount === 1 ? "message" : "messages"}`,
                              onClick: Message.RevealedMiddle({
                                firstMessageId: firstHidden,
                              }),
                            },
                            h,
                          ),
                        ],
                      ),
                    ]
                  : [row];
              }),
            ),
          ]
        : []),
      ...(active && !messages.some(({ id }) => id === active.id)
        ? entryContent(model, h)
        : []),
      ...(model.folder !== "trash" &&
      latest &&
      model.list?.sender &&
      !model.list.indexing
        ? [
            h.submodel({
              slotId: "inbox-inline-reply",
              view: QuickReply.view,
              model: {
                state: model.quickReply,
                anchor: selected,
                latest: latest.id,
                latestIncoming:
                  messages.findLast(({ folder }) => folder === "inbox")?.id ??
                  null,
              },
              toParentMessage: toQuickReplyMessage,
            }),
          ]
        : []),
    ],
  );
  return h.article(
    [
      h.Key(selected),
      h.Class("workspace-detail inbox-reader"),
      h.AriaLabel("Message"),
      h.Tabindex(-1),
      h.OnMount(FocusEntry()),
    ],
    [content],
  );
};

const mailboxIcons = {
  inbox:
    "M4 12l2.5-7h11l2.5 7v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6Zm0 0h4l2 3h4l2-3h4",
  sent: "m21 3-6 18-4-8-8-4 18-6Zm0 0L11 13",
  all: "M5 8h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Zm0 1 7 6 7-6M7 4h10",
  archive: "M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8Zm-1-4h18v4H3zM10 12h4",
  trash: "M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
} as const;

const folderNavigation = (
  model: Model,
  mailboxes: readonly Mailbox[] | null,
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [],
    [
      ...(mailboxes?.length
        ? [
            navigationLinks(
              {
                label: "Your mailboxes",
                variant: "sidebar",
                destinations: mailboxes.map(({ id, name }) => ({
                  href: mailboxUrl(mailPath, id),
                  label: name,
                  current: id === selectedMailbox(),
                })),
              },
              h,
            ),
            h.hr([h.Class("mailbox-nav-divider")]),
          ]
        : []),
      navigationLinks(
        {
          label: "Mailbox navigation",
          variant: "sidebar",
          destinations: (
            ["inbox", "sent", "all", "archive", "trash"] as const
          ).map((folder) => ({
            href: selectedMailboxUrl(folderPath(folder)),
            label: mailboxLabels[folder],
            icon: mailIcon(h, mailboxIcons[folder]),
            current:
              folder === model.folder ||
              (folder === "inbox" && isInboxView(model.folder)),
            unread: folder === "inbox" ? model.unreadCount : 0,
          })),
        },
        h,
      ),
      h.hr([h.Class("mailbox-nav-divider")]),
      navigationLinks(
        {
          label: "Mail settings",
          variant: "sidebar",
          destinations: [{ href: mailSettingsPath, label: "Mail settings" }],
        },
        h,
      ),
    ],
  );

type ViewInputs = {
  mailboxes: readonly Mailbox[] | null;
  mailboxesError: string;
};

const inboxView = (
  snapshot: Model,
  { mailboxes, mailboxesError }: ViewInputs,
  h: HtmlBuilder<Message>,
) => {
  const entry = snapshot.entry;
  const pending = entry && snapshot.readRequests[entry.id];
  const model = {
    ...snapshot,
    list: visibleList(snapshot),
    thread: projectThread(snapshot),
    entry:
      pending && entry && "receivedAt" in entry
        ? { ...entry, unread: pending.unread }
        : entry,
    unreadCount: visibleUnreadCount(snapshot),
  };
  const mailbox = mailboxes?.find(({ id }) => id === selectedMailbox());
  const unavailable = mailboxes !== null && !mailbox;
  const listVisible = isListVisible(model);
  const showPrioritySwitch = listVisible && isInboxView(model.folder);
  const listIndicator = listVisible
    ? [
        h.span(
          [h.Class("inbox-list-indicator")],
          model.listRequest
            ? [
                spinner(
                  model.listRequest.cursor !== null
                    ? "Loading more messages…"
                    : model.list
                      ? "Refreshing messages…"
                      : "Loading messages…",
                  h,
                ),
              ]
            : [],
        ),
      ]
    : [];

  return workspace(
    {
      className: "inbox",
      attributes: [h.OnMount(WatchLayout())],
      layout: isSplitView(model) ? "split" : "stacked",
      header: screenHeader(
        {
          title:
            mailbox && mailbox.id !== defaultMailboxId
              ? `${mailbox.name} · ${mailboxLabels[model.folder]}`
              : mailboxLabels[model.folder],
          navigation: [
            ...(!listVisible
              ? [
                  button(
                    {
                      variant: "ghost",
                      size: "icon-sm",
                      ariaLabel: "Back",
                      onClick: Message.RequestedBack(),
                      children: [backIcon(h)],
                    },
                    h,
                  ),
                ]
              : []),
            h.div(
              [h.Class("workspace-drawer-trigger")],
              [
                button(
                  {
                    variant: "ghost",
                    size: "icon-sm",
                    ariaLabel: "Mail folders",
                    dialogId: model.folderSheet.id,
                    onClick: Message.GotFolderSheetMessage({
                      message: Sheet.Message.RequestedOpen(),
                    }),
                    children: [mailIcon(h, "M4 6h16M4 12h16M4 18h16")],
                  },
                  h,
                ),
              ],
            ),
          ],
          controls: [
            ...(model.selected === null && model.folder === "trash"
              ? [
                  button(
                    {
                      size: "sm",
                      variant: "outline",
                      dialogId: emptyTrashDialogId,
                      disabled:
                        !canEmptyTrash(model) ||
                        model.emptyTrashRequest !== null,
                      onClick: toEmptyTrashDialogMessage(
                        Dialog.Message.RequestedOpen(),
                      ),
                      children: ["Empty trash"],
                    },
                    h,
                  ),
                ]
              : listVisible && supportsMailFilters(model.folder)
                ? [
                    h.submodel({
                      slotId: "inbox-filters",
                      model: model.filters,
                      view: Filters.view,
                      toParentMessage: toFiltersMessage,
                    }),
                  ]
                : []),
            ...(showPrioritySwitch ? [] : listIndicator),
          ],
          viewControls: showPrioritySwitch
            ? [inboxPrioritySwitch(model.folder, h), ...listIndicator]
            : undefined,
          endControls: [
            workspaceLayoutButton(model.layout, Message.ToggledSplitView(), h),
          ],
        },
        h,
      ),
      sidebar: folderNavigation(model, mailboxes, h),
      list:
        unavailable || mailboxesError
          ? h.div(
              [h.Class("inbox-status"), h.Role("status")],
              [
                h.p(
                  [],
                  [
                    mailboxesError ||
                      (mailboxes?.length
                        ? "Select a mailbox you own."
                        : "Create a mailbox in Mail settings to get started."),
                  ],
                ),
                h.a([h.Href(mailSettingsPath)], ["Mail settings"]),
              ],
            )
          : listView(model, h),
      ...(model.selected
        ? { detail: entryView(model, model.selected, h) }
        : {}),
      hasSelection: model.selected !== null,
      sheet: Sheet.sheet(
        {
          model: model.folderSheet,
          title: "Mail folders",
          content: folderNavigation(model, mailboxes, h),
          toParentMessage: (message) =>
            Message.GotFolderSheetMessage({ message }),
        },
        h,
      ),
    },
    h,
  );
};

export const view = Submodel.defineView<Model, Message, ViewInputs>(inboxView);
