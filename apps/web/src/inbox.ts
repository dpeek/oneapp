import {
  avatarGroup,
  backIcon,
  button,
  buttonClassName,
  DropdownMenu,
  ellipsisIcon,
  item,
  itemDisclosure,
  itemGroup,
  marker,
  navigationLinks,
  Sheet,
  spinner,
  timestamp,
  unreadBadge,
} from "@oneapp/ui";
import { Effect, Option, Queue, Schema, Stream } from "effect";
import { Command, Submodel, Update } from "foldkit";
import { focus } from "foldkit/dom";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
import * as Attachments from "./inbox-attachments.ts";
import { mailHtmlDocument, mailHtmlSandbox } from "./inbox-html.ts";
import * as Compose from "./inbox-compose.ts";
import * as QuickReply from "./inbox-inline-reply.ts";
import {
  collapsibleMiddleCount,
  conversationPeople,
  conversationSubject,
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
  inboxChanged,
  inboxComposeLimits,
  InboxEntry,
  inboxEventsPath,
  InboxMessageId,
  inboxOriginalApi,
  inboxReadApi,
  InboxUnread,
  inboxUnreadPath,
  isInboxView,
  MailEntry,
  MailFolder,
  MailboxView,
  MailMessageId,
  MailPage,
  MailRoute,
  type MailPerson,
  mailMessageApi,
  mailMessagePage,
  noiseApiPath,
  replySubject,
  SentEntry,
  sentApiPath,
  SentMessageId,
  SentPage,
  SenderPriority,
  SenderRule,
  senderRuleApiPath,
} from "./inbox-contract.ts";
import {
  normalizePersonEmail,
  PersonEmail,
  type PersonMatch,
  type PersonSummary,
} from "./people-contract.ts";
import { avatar } from "./people.ts";
import { workspace, workspaceDrawerMedia } from "./workspace.ts";

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
} satisfies Record<MailboxView, string>;
const mailboxApiPaths = {
  inbox: conversationsApiPath,
  noise: noiseApiPath,
  sent: sentApiPath,
  all: allMailApiPath,
  archive: archiveApiPath,
};

const ArchiveChange = Schema.Struct({
  id: InboxMessageId,
  archived: Schema.Boolean,
});

const ArchiveRequest = Schema.Struct({
  ...ArchiveChange.fields,
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
type MessageAction = "toggleUnread" | "download" | "delete";
const conversationMenu = DropdownMenu.create<ConversationAction>();
const messageMenu = DropdownMenu.create<MessageAction>();

export const Model = Schema.Struct({
  folder: MailboxView,
  folderSheet: Sheet.Model,
  conversationMenu: DropdownMenu.Model,
  messageMenu: DropdownMenu.Model,
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
  unreadCount: Schema.Number,
  unreadRequest: Schema.NullOr(Schema.String),
  unreadRefreshQueued: Schema.Boolean,
  readRequests: Schema.Record(Schema.String, Schema.String),
  readFailed: Schema.NullOr(InboxMessageId),
  selected: Schema.NullOr(MailMessageId),
  middleRevealed: Schema.Boolean,
  active: Schema.NullOr(MessageLocation),
  thread: Schema.NullOr(Conversation),
  threadRequest: Schema.NullOr(Schema.String),
  threadRefreshQueued: Schema.Boolean,
  threadFailed: Schema.Boolean,
  entry: Schema.NullOr(MailEntry),
  entryRequest: Schema.NullOr(Schema.String),
  entryError: Schema.NullOr(Schema.String),
  attachmentPreview: Attachments.State,
  deleteTarget: Schema.NullOr(MessageLocation),
  deleteRequest: Schema.NullOr(
    Schema.Struct({
      id: MailMessageId,
      request: Schema.String,
      folder: MailFolder,
    }),
  ),
  deleteFailed: Schema.Boolean,
  archiveRequest: Schema.NullOr(ArchiveRequest),
  archiveNotice: Schema.NullOr(ArchiveChange),
  archiveError: Schema.NullOr(Schema.String),
  senderRuleRequest: Schema.NullOr(SenderRuleRequest),
  senderRuleFailed: Schema.Boolean,
  compose: Compose.Model,
  quickReply: QuickReply.Model,
});
type Model = typeof Model.Type;

export const initial: Model = {
  folder: "inbox",
  folderSheet: Sheet.init({ id: "mail-folders" }),
  conversationMenu: DropdownMenu.init({ id: "mail-conversation-actions" }),
  messageMenu: DropdownMenu.init({ id: "mail-message-actions" }),
  list: null,
  listRequest: null,
  listRefreshQueued: false,
  listError: null,
  unreadCount: 0,
  unreadRequest: null,
  unreadRefreshQueued: false,
  readRequests: {},
  readFailed: null,
  selected: null,
  middleRevealed: false,
  active: null,
  thread: null,
  threadRequest: null,
  threadRefreshQueued: false,
  threadFailed: false,
  entry: null,
  entryRequest: null,
  entryError: null,
  attachmentPreview: null,
  deleteTarget: null,
  deleteRequest: null,
  deleteFailed: false,
  archiveRequest: null,
  archiveNotice: null,
  archiveError: null,
  senderRuleRequest: null,
  senderRuleFailed: false,
  compose: Compose.initial,
  quickReply: QuickReply.initial,
};

export const Message = defineMessageUnion({
  Opened: MailRoute.fields,
  GotFolderSheetMessage: { message: Sheet.Message },
  RetriedList: {},
  RefreshedUnread: {},
  GotComposeMessage: { message: Compose.Message },
  GotQuickReplyMessage: { message: QuickReply.Message },
  GotAttachmentMessage: { message: Attachments.Message },
  LiveChanged: {},
  RequestedMore: { folder: MailboxView, cursor: Schema.String },
  RetriedEntry: {},
  RetriedThread: {},
  UpdatedProfiles: {},
  ToggledMessage: MessageLocation.fields,
  RevealedMiddle: { firstMessageId: MailMessageId },
  RequestedBack: {},
  RequestedPerson: { address: Schema.String, name: Schema.String },
  RequestedReply: {},
  DownloadStarted: {},
  CanceledDelete: {},
  ConfirmedDelete: {},
  DeletedEntry: { id: MailMessageId, request: Schema.String },
  DeleteFailed: { request: Schema.String },
  GotConversationMenuMessage: { message: DropdownMenu.Message },
  GotMessageMenuMessage: { message: DropdownMenu.Message },
  UndidArchive: {},
  ArchiveChanged: { request: Schema.String },
  ArchiveFailed: { request: Schema.String, error: Schema.String },
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
    unread: Schema.Boolean,
  },
  ReadStatusFailed: { request: Schema.String, id: InboxMessageId },
  LoadedThread: { request: Schema.String, thread: Conversation },
  ThreadFailed: { request: Schema.String },
  LoadedEntry: { request: Schema.String, entry: MailEntry },
  EntryFailed: { request: Schema.String, missing: Schema.Boolean },
  SessionExpired: { request: Schema.String },
  FocusUpdated: {},
});
type Message = typeof Message.Type;

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

export const changes = Stream.callback<Message>(
  (queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const url = new URL(inboxEventsPath, window.location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        let stopped = false;
        let socket: WebSocket | undefined;
        let retry: number | undefined;
        let delay = 1000;
        const changed = () => {
          if (!stopped) Queue.offerUnsafe(queue, Message.LiveChanged());
        };
        const connect = () => {
          const connection = new WebSocket(url);
          socket = connection;
          connection.onopen = () => {
            delay = 1000;
            changed();
          };
          connection.onmessage = (event) => {
            if (event.data === inboxChanged) changed();
          };
          connection.onclose = (event) => {
            if (stopped) return;
            if (event.code === 1008) changed();
            retry = window.setTimeout(connect, delay);
            delay = Math.min(delay * 2, 30_000);
          };
        };
        connect();
        return () => {
          stopped = true;
          window.clearTimeout(retry);
          socket?.close();
        };
      }),
      (stop) => Effect.sync(stop),
    ).pipe(Effect.andThen(Effect.never)),
  { bufferSize: 1, strategy: "sliding" },
);

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

const FocusMessageSummary = Command.define("FocusInboxMessageSummary", {
  args: { id: MailMessageId },
  messages: [Message.FocusUpdated],
  execute: ({ id }) =>
    focus(`.inbox-reader [data-thread-message-id="${CSS.escape(id)}"]`, {
      preventScroll: true,
    }).pipe(Effect.ignore, Effect.as(Message.FocusUpdated())),
});

const ShowDeleteDialog = Mount.define("ShowInboxDeleteDialog", {
  messages: [Message.FocusUpdated],
  execute: ({ element }) =>
    Effect.sync(() => {
      if (element instanceof HTMLDialogElement && !element.open)
        element.showModal();
      return Message.FocusUpdated();
    }),
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
  },
  messages: [Message.LoadedList, Message.ListFailed, Message.SessionExpired],
  execute: ({ request, cursor, folder, minimum }) =>
    Effect.tryPromise(async (signal) => {
      const path = mailboxApiPaths[folder];
      let nextCursor = cursor;
      let page: typeof MailPage.Type | null = null;
      do {
        const query =
          nextCursor === null
            ? ""
            : "?" + new URLSearchParams({ cursor: nextCursor });
        const response = await fetch(path + query, {
          cache: "no-store",
          signal,
        });
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
      const response = await fetch(inboxUnreadPath, {
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
      const response = await fetch(inboxReadApi(id), {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-effect-auth-csrf": "1",
        },
        body: JSON.stringify({ unread }),
        signal,
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      return response.status === 204
        ? Message.UpdatedReadStatus({ request, id, unread })
        : Message.ReadStatusFailed({ request, id });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(Message.ReadStatusFailed({ request, id })),
      ),
    ),
});

const LoadThread = Command.define("LoadMailConversation", {
  args: { request: Schema.String, id: MailMessageId },
  messages: [
    Message.LoadedThread,
    Message.ThreadFailed,
    Message.SessionExpired,
  ],
  execute: ({ request, id }) =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(conversationApi(id), {
        cache: "no-store",
        signal,
      });
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
  args: { request: Schema.String, id: MailMessageId, folder: MailFolder },
  messages: [Message.LoadedEntry, Message.EntryFailed, Message.SessionExpired],
  execute: ({ request, id, folder }) =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(mailMessageApi(folder, id), {
        cache: "no-store",
        signal,
      });
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

const DeleteEntry = Command.define("DeleteInboxEntry", {
  args: { request: Schema.String, id: MailMessageId, folder: MailFolder },
  messages: [
    Message.DeletedEntry,
    Message.DeleteFailed,
    Message.SessionExpired,
  ],
  execute: ({ request, id, folder }) =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(mailMessageApi(folder, id), {
        method: "DELETE",
        headers: { "x-effect-auth-csrf": "1" },
        signal,
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      return response.status === 204
        ? Message.DeletedEntry({ id, request })
        : Message.DeleteFailed({ request });
    }).pipe(
      Effect.catch(() => Effect.succeed(Message.DeleteFailed({ request }))),
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
      const response = await fetch(conversationArchiveApi(id), {
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
      const response = await fetch(senderRuleApiPath, {
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
  args: { id: InboxMessageId },
  messages: [Message.DownloadStarted],
  execute: ({ id }) =>
    Effect.sync(() => {
      const link = document.createElement("a");
      link.href = inboxOriginalApi(id);
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
        minimum:
          cursor === null && model.folder !== "sent"
            ? (model.list?.messages.length ?? 0)
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
): Update.Return<Model, Message> => {
  const request = crypto.randomUUID();
  return {
    model: {
      ...model,
      archiveRequest: { ...change, request, folder: model.folder, selected },
      archiveError: null,
    },
    commands: [SaveArchive({ ...change, request })],
  };
};

const loadEntry = (model: Model): Update.Return<Model, Message> => {
  if (!model.active || model.entryRequest !== null) return { model };
  const request = crypto.randomUUID();
  return {
    model: { ...model, entryRequest: request, entryError: null },
    commands: [LoadEntry({ request, ...model.active })],
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
    attachmentPreview: null,
    deleteFailed: false,
  });

const refreshThread = (model: Model): Update.Return<Model, Message> => {
  if (!model.selected) return { model };
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
    commands: [LoadThread({ id: model.selected, request })],
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

const setUnread = (
  model: Model,
  id: string,
  unread: boolean,
): Update.Return<Model, Message> => {
  if (model.readRequests[id]) return { model };
  const request = crypto.randomUUID();
  return {
    model: {
      ...model,
      readFailed: null,
      readRequests: { ...model.readRequests, [id]: request },
    },
    commands: [SetUnread({ id, unread, request })],
  };
};

const finishUnread = (
  model: Model,
  request: string,
  unreadCount = model.unreadCount,
) => {
  if (request !== model.unreadRequest) return { model };
  const next = { ...model, unreadCount, unreadRequest: null };
  return next.unreadRefreshQueued ? refreshUnread(next) : { model: next };
};

const finishReadStatus = (model: Model, id: string): Model => {
  const { [id]: _completed, ...readRequests } = model.readRequests;
  return { ...model, readRequests };
};

const quoteMessage = (entry: typeof InboxEntry.Type) => {
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

const selectedMessage = (model: Model): Model["active"] =>
  model.active ??
  (model.selected
    ? { id: model.selected, folder: messageFolder(model.selected) }
    : null);

const changeSenderPriority = (
  model: Model,
  priority: typeof SenderPriority.Type,
): Update.Return<Model, Message> => {
  const rule = model.thread?.senderRule;
  if (!rule || model.senderRuleRequest || rule.priority === priority)
    return { model };
  const change = {
    address: rule.address,
    priority,
    request: crypto.randomUUID(),
  };
  return {
    model: { ...model, senderRuleRequest: change, senderRuleFailed: false },
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
            )
          : { model };
      }
      return changeSenderPriority(model, value);
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
      if (value === "delete") {
        return model.deleteRequest
          ? { model }
          : { model: { ...model, deleteTarget: active, deleteFailed: false } };
      }
      if (active.folder !== "inbox") return { model };
      if (value === "download") {
        return { model, commands: [DownloadOriginal({ id: active.id })] };
      }
      return entry?.id === active.id && "receivedAt" in entry
        ? setUnread(model, entry.id, !entryUnread(model))
        : { model };
    },
});

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    GotFolderSheetMessage: ({ message }) =>
      message._tag === "RequestedOpen" &&
      !matchMedia(workspaceDrawerMedia).matches
        ? { model }
        : foldFolderSheet(model, message),
    GotConversationMenuMessage: ({ message }) =>
      foldConversationMenu(model, message),
    GotMessageMenuMessage: ({ message }) => foldMessageMenu(model, message),
    Opened: ({ id, folder }) => {
      const base =
        folder === model.folder
          ? model
          : {
              ...initial,
              folder,
              folderSheet: model.folderSheet,
              compose: model.compose,
              quickReply: model.quickReply,
              deleteRequest: model.deleteRequest,
              archiveRequest: model.archiveRequest,
              archiveNotice: model.archiveNotice,
              senderRuleRequest: model.senderRuleRequest,
              unreadCount: model.unreadCount,
              unreadRequest: model.unreadRequest,
              unreadRefreshQueued: model.unreadRefreshQueued,
              readRequests: model.readRequests,
            };
      const next =
        base.selected === id
          ? { ...base, deleteTarget: null }
          : {
              ...base,
              selected: id,
              conversationMenu: initial.conversationMenu,
              messageMenu: initial.messageMenu,
              middleRevealed: false,
              senderRuleFailed: false,
              active: id ? { id, folder: messageFolder(id) } : null,
              thread: null,
              threadRequest: null,
              threadRefreshQueued: false,
              threadFailed: false,
              entry: null,
              entryRequest: null,
              entryError: null,
              attachmentPreview: null,
              deleteTarget: null,
              deleteFailed: false,
            };
      const previous = id === null ? base.selected : null;
      const list = id && next.list ? { model: next } : loadList(next, null);
      const result = next.thread ? list : withThread(list);
      if (!previous) return result;
      const row = base.list?.messages.find(
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
    GotAttachmentMessage: ({ message }) => foldAttachments(model, message),
    RefreshedUnread: () => refreshUnread(model),
    GotComposeMessage: ({ message }) => {
      const result = foldCompose(model, message);
      if (message._tag !== "Sent" || model.compose.request !== message.request)
        return result;
      const original = model.compose.reply?.originalId;
      const showReply = Boolean(
        original &&
        (original === model.selected ||
          model.thread?.messages.some(({ id }) => id === original)),
      );
      return afterSend(result, message, showReply);
    },
    GotQuickReplyMessage: ({ message }) => {
      const result = foldQuickReply(model, message);
      return message._tag === "Sent" &&
        message.request === model.quickReply.request
        ? afterSend(result, message, model.quickReply.anchor === model.selected)
        : result;
    },
    LiveChanged: () =>
      withUnread(
        withThread(model.folder !== "sent" ? refreshList(model) : { model }),
      ),
    RequestedMore: ({ folder, cursor }) =>
      model.selected === null &&
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
    UndidArchive: () =>
      model.archiveNotice?.archived && !model.archiveRequest
        ? changeArchive(
            model,
            { id: model.archiveNotice.id, archived: false },
            null,
          )
        : { model },
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
        archiveNotice: { id: change.id, archived: change.archived },
        archiveError: null,
      };
      return withUnread(
        withThread(
          model.folder !== "sent" ? loadList(next, null) : { model: next },
        ),
      );
    },
    ArchiveFailed: ({ request, error }) =>
      request === model.archiveRequest?.request
        ? withThread(
            refreshList({
              ...model,
              archiveRequest: null,
              archiveError: error,
            }),
          )
        : { model },
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
      return withThread(
        refreshList({ ...model, thread, senderRuleRequest: null }),
      );
    },
    SenderRuleFailed: ({ request }) =>
      request === model.senderRuleRequest?.request
        ? {
            model: {
              ...model,
              senderRuleRequest: null,
              senderRuleFailed: true,
            },
          }
        : { model },
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
            ...entry.reply,
            originalId: entry.id,
            subject: replySubject(entry.subject),
            text: quoteMessage(entry),
          },
        }),
      );
    },
    DownloadStarted: () => ({ model }),
    CanceledDelete: () => ({ model: { ...model, deleteTarget: null } }),
    ConfirmedDelete: () => {
      if (!model.deleteTarget || model.deleteRequest) return { model };
      const deletion = {
        ...model.deleteTarget,
        request: crypto.randomUUID(),
      };
      return {
        model: { ...model, deleteTarget: null, deleteRequest: deletion },
        commands: [DeleteEntry(deletion)],
      };
    },
    DeletedEntry: ({ id, request }) => {
      if (request !== model.deleteRequest?.request) return { model };
      const list = model.list && {
        ...model.list,
        messages: model.list.messages.filter((message) => message.id !== id),
      };
      const thread = model.thread && {
        ...model.thread,
        messages: model.thread.messages.filter((message) => message.id !== id),
      };
      const next: Model = {
        ...model,
        list,
        thread,
        threadRequest: null,
        listRequest: null,
        deleteRequest: null,
        ...(model.active?.id === id
          ? {
              messageMenu: initial.messageMenu,
              active:
                model.selected && model.selected !== id
                  ? {
                      id: model.selected,
                      folder: messageFolder(model.selected),
                    }
                  : null,
              entry: null,
              entryRequest: null,
              entryError: null,
              attachmentPreview: null,
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
      return withUnread(model.selected === id ? command : withThread(command));
    },
    DeleteFailed: ({ request }) =>
      request !== model.deleteRequest?.request
        ? { model }
        : {
            model: {
              ...model,
              deleteRequest: null,
              deleteFailed:
                selectedMessage(model)?.id === model.deleteRequest.id,
            },
          },
    LoadedList: ({ request, page }) => {
      if (request !== model.listRequest?.id) return { model };
      const { cursor } = model.listRequest;
      const next = {
        ...model,
        listRequest: null,
        list:
          cursor !== null && model.list
            ? { ...page, messages: [...model.list.messages, ...page.messages] }
            : page,
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
    LoadedUnread: ({ request, unreadCount }) =>
      finishUnread(model, request, unreadCount),
    UnreadFailed: ({ request }) => finishUnread(model, request),
    UpdatedReadStatus: ({ request, id, unread }) => {
      if (model.readRequests[id] !== request) return { model };
      const next = finishReadStatus(model, id);
      const entry =
        next.entry?.id === id && "receivedAt" in next.entry
          ? { ...next.entry, unread }
          : next.entry;
      const thread = next.thread && {
        ...next.thread,
        messages: next.thread.messages.map((message) =>
          message.id === id ? { ...message, unread } : message,
        ),
      };
      const updated = { ...next, entry, thread };
      return withUnread(
        withThread(
          updated.folder !== "sent" ? refreshList(updated) : { model: updated },
        ),
      );
    },
    ReadStatusFailed: ({ request, id }) =>
      model.readRequests[id] === request
        ? { model: { ...finishReadStatus(model, id), readFailed: id } }
        : { model },
    LoadedThread: ({ request, thread }) => {
      if (request !== model.threadRequest) return { model };
      const newestIncoming = thread.messages.findLast(
        ({ folder }) => folder === "inbox",
      );
      const latest =
        !model.thread &&
        !model.entry &&
        !model.entryRequest &&
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
      const next = { ...model, entry, entryRequest: null };
      return "receivedAt" in entry && entry.unread
        ? setUnread(next, entry.id, false)
        : { model: next };
    },
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
    }
  >();
  for (const { address, name } of participants) {
    const email = normalizePersonEmail(address);
    const person = profiles.get(email);
    const key = person?.id ?? email;
    const participant = groups.get(key);
    if (participant) participant.addresses.push(address);
    else
      groups.set(key, {
        addresses: [address],
        name: person?.name || name,
        person,
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
  const participants = groupParticipants(
    people.length ? people : [{ address: message.from, name: "" }],
    findProfiles(sent ? undefined : message.profiles),
  );
  const unreadCount = sent ? 0 : message.unreadCount;
  const unread = unreadCount > 0;
  const current =
    model.selected === message.id ||
    (model.folder !== "sent" &&
      model.thread?.messages.some(({ id }) => id === message.id));
  return item(
    {
      key: message.id,
      href: mailMessagePage(model.folder, message.id),
      title: subject,
      linkAttributes: [
        h.DataAttribute("message-id", message.id),
        ...(current ? [h.AriaCurrent("page")] : []),
        ...(unread ? [h.DataAttribute("unread", "")] : []),
      ],
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
              timestamp(sent ? message.sentAt : message.lastMessageAt, now, h),
            ],
          ),
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
                    },
                  ]) => ({
                    key,
                    label:
                      sent && !address
                        ? "Unknown recipient"
                        : participantTooltip(name, address, aliases),
                    picture: avatar(h, person, address, name),
                  }),
                ),
                h,
              ),
              ...(unread
                ? [
                    unreadBadge(
                      h,
                      unreadCount,
                      `${unreadCount} unread ${unreadCount === 1 ? "message" : "messages"}`,
                    ),
                  ]
                : []),
              ...(!sent && message.archived
                ? [h.span([h.Class("inbox-conversation-done")], ["Done"])]
                : []),
            ],
          ),
        ],
      ),
    },
    h,
  );
};

const archiveFeedback = (model: Model, h: HtmlBuilder<Message>) => [
  ...(model.archiveError
    ? [
        h.p(
          [h.Class("inbox-archive-feedback"), h.Role("alert")],
          [model.archiveError],
        ),
      ]
    : []),
  ...(model.archiveNotice
    ? [
        h.div(
          [h.Class("inbox-archive-feedback")],
          [
            h.span(
              [h.Role("status")],
              [
                model.archiveNotice.archived
                  ? "Conversation marked done."
                  : "Conversation moved to Inbox.",
              ],
            ),
            ...(model.archiveNotice.archived
              ? [
                  h.button(
                    [
                      h.Type("button"),
                      h.Disabled(model.archiveRequest !== null),
                      h.OnClick(Message.UndidArchive()),
                    ],
                    ["Undo"],
                  ),
                ]
              : []),
          ],
        ),
      ]
    : []),
];

const inboxPriorityTabs = (selected: MailboxView, h: HtmlBuilder<Message>) =>
  navigationLinks(
    {
      label: "Inbox priority",
      variant: "tabs-line",
      destinations: (["inbox", "noise"] as const).map((folder) => ({
        href: folderPath(folder),
        label: folder === "inbox" ? "Signal" : "Noise",
        current: folder === selected,
      })),
    },
    h,
  );

const listLoading = (label: string, h: HtmlBuilder<Message>) =>
  h.div([h.Class("inbox-list-loading")], [spinner(label, h)]);

const listFailure = (message: string, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("inbox-status")],
    [
      h.p([h.Role("alert")], [message]),
      h.button([h.Type("button"), h.OnClick(Message.RetriedList())], ["Retry"]),
    ],
  );

const listView = (model: Model, h: HtmlBuilder<Message>) => {
  const now = Date.now();
  const { list, listRequest, listError, folder, selected } = model;
  return h.section(
    [
      h.Class("workspace-list inbox-list"),
      h.AriaLabel("Messages"),
      h.Inert(selected !== null),
      h.Tabindex(-1),
    ],
    [
      ...(selected === null ? archiveFeedback(model, h) : []),
      h.div(
        [h.Key(folder), h.Class("workspace-results")],
        [
          ...(listRequest?.cursor === null
            ? [listLoading("Loading messages…", h)]
            : []),
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
                !list.indexing &&
                listRequest === null
                  ? h.p(
                      [h.Class("inbox-status")],
                      [
                        folder === "archive"
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
                ...(listRequest?.cursor != null
                  ? [listLoading("Loading more messages…", h)]
                  : []),
                ...(listError?.cursor != null
                  ? [listFailure(listError.message, h)]
                  : []),
                ...(list.cursor &&
                !list.indexing &&
                !listRequest &&
                !listError &&
                selected === null
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
    ],
  );
};

const previewNotice = {
  truncated: "This preview is shortened.",
  tooLarge: "This message is too large to preview.",
  unreadable: "This message could not be previewed.",
};

const deleteDialog = (h: HtmlBuilder<Message>) =>
  h.dialog(
    [
      h.Class("inbox-delete-dialog"),
      h.AriaLabelledBy("inbox-delete-title"),
      h.AriaDescribedBy("inbox-delete-description"),
      h.OnMount(ShowDeleteDialog()),
      h.OnCancel(Message.CanceledDelete()),
    ],
    [
      h.h2([h.Id("inbox-delete-title")], ["Permanently delete this email?"]),
      h.p(
        [h.Id("inbox-delete-description")],
        ["The email and its attachments will be permanently removed."],
      ),
      h.div(
        [h.Class("inbox-delete-actions")],
        [
          h.button(
            [
              h.Type("button"),
              h.Autofocus(true),
              h.OnClick(Message.CanceledDelete()),
            ],
            ["Cancel"],
          ),
          h.button(
            [
              h.Type("button"),
              h.Class("inbox-delete-button"),
              h.OnClick(Message.ConfirmedDelete()),
            ],
            ["Permanently delete"],
          ),
        ],
      ),
    ],
  );

const entryContent = (model: Model, h: HtmlBuilder<Message>) => {
  const { entry } = model;
  const html = entry && "html" in entry ? entry.html : undefined;
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
                h.p(
                  [h.Class("inbox-preview")],
                  ["Remote images are blocked for privacy."],
                ),
              ]
            : []),
          ...(entry.text
            ? [
                (html ? h.details : h.div)(
                  [h.Class("inbox-body")],
                  [
                    ...(html ? [h.summary([], ["Plain text"])] : []),
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
                                        rounded: true,
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
          ...("receivedAt" in entry && entry.attachments?.length
            ? [
                h.submodel({
                  slotId: `inbox-attachments-${entry.id}`,
                  view: Attachments.view,
                  model: {
                    id: entry.id,
                    attachments: entry.attachments,
                    preview: model.attachmentPreview,
                  },
                  toParentMessage: toAttachmentMessage,
                }),
              ]
            : []),
          ...("receivedAt" in entry && entry.reply && model.list?.sender
            ? [
                h.div(
                  [h.Class("inbox-toolbar-actions")],
                  [
                    h.button(
                      [h.Type("button"), h.OnClick(Message.RequestedReply())],
                      ["Reply"],
                    ),
                  ],
                ),
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
    editLabel,
  }: {
    address: string;
    person: PersonSummary | undefined;
    name: string;
    aliases?: readonly string[];
    editLabel: string;
  },
) => {
  const tooltip = participantTooltip(name, address, aliases);
  const picture = avatar(h, person, address, name);
  return isPersonEmail(address)
    ? h.button(
        [
          h.Type("button"),
          h.Class("inbox-profile-button"),
          h.Title(tooltip),
          h.AriaLabel(editLabel),
          h.OnClick(Message.RequestedPerson({ address, name })),
        ],
        [picture],
      )
    : h.span(
        [h.Title(tooltip), h.Role("img"), h.AriaLabel(tooltip)],
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

const conversationActions = (model: Model, h: HtmlBuilder<Message>) => {
  const items: DropdownMenu.Item<ConversationAction>[] = [];
  const canArchive =
    model.folder !== "sent" &&
    model.thread?.messages.some(({ folder }) => folder === "inbox");
  if (canArchive) {
    const archived = model.thread?.archived;
    items.push({
      action: "archive",
      label: archived ? "Move to Inbox" : "Mark done",
      icon: mailIcon(
        h,
        archived ? "M9 14 4 9l5-5M4 9h10a5 5 0 0 1 0 10" : "m5 12 4 4L19 6",
      ),
    });
  }
  const rule = model.thread?.senderRule;
  if (rule) {
    const pending = model.senderRuleRequest !== null;
    items.push(
      {
        action: "signal",
        label: "Sender → Signal",
        disabled: pending || rule.priority === "signal",
        icon: mailIcon(h, "M2 12c2-6 4-6 6 0s4 6 6 0 4-6 6 0"),
      },
      {
        action: "noise",
        label: "Sender → Noise",
        disabled: pending || rule.priority === "noise",
        icon: mailIcon(h, "M3 10v4m4-7v10m5-14v18m5-14v10m4-7v4"),
      },
    );
    if (rule.priority !== "automatic") {
      items.push({
        action: "automatic",
        label: "Sender → Automatic",
        disabled: pending,
        icon: mailIcon(h, "M3 12a9 9 0 1 1 2.7 6.4M3 12V5m0 7h7"),
      });
    }
  }
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

const messageActions = (model: Model, h: HtmlBuilder<Message>) => {
  const { active, entry } = model;
  if (!active) return h.empty;
  const items: DropdownMenu.Item<MessageAction>[] = [];
  if (active.folder === "inbox") {
    if (entry?.id === active.id && "receivedAt" in entry) {
      items.push({
        action: "toggleUnread",
        label: entryUnread(model) ? "Mark read" : "Mark unread",
        disabled: Boolean(model.readRequests[entry.id]),
        icon: mailIcon(h, "M3 5h18v14H3zM3 6l9 7 9-7"),
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
  items.push({
    action: "delete",
    label: "Delete message",
    disabled: model.deleteRequest !== null,
    destructive: true,
    icon: mailIcon(
      h,
      "M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6m5 4v7m4-7v7",
    ),
  });
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
      ...archiveFeedback(model, h),
      ...(model.senderRuleFailed
        ? [
            h.p(
              [h.Role("alert")],
              ["Could not update sender priority. Try again."],
            ),
          ]
        : []),
      ...(model.deleteFailed
        ? [
            h.p(
              [h.Role("alert")],
              ["Could not confirm the deletion. Try again."],
            ),
          ]
        : []),
      ...(model.deleteTarget ? [deleteDialog(h)] : []),
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
                            },
                          ]) => ({
                            key,
                            label: participantTooltip(name, address, aliases),
                            picture: profileAvatar(h, {
                              address,
                              person,
                              name,
                              aliases,
                              editLabel: `Edit participant profile for ${address}`,
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
                      editLabel: `Edit profile for ${address}`,
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
                      ...(expanded ? [messageActions(model, h)] : []),
                      timestamp(messageTime, now, h),
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
      ...(latest && model.list?.sender && !model.list.indexing
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
} as const;

const folderNavigation = (model: Model, h: HtmlBuilder<Message>) =>
  navigationLinks(
    {
      label: "Mailbox navigation",
      variant: "sidebar",
      destinations: (["inbox", "sent", "all", "archive"] as const).map(
        (folder) => ({
          href: folderPath(folder),
          label: mailboxLabels[folder],
          icon: mailIcon(h, mailboxIcons[folder]),
          current:
            folder === model.folder ||
            (folder === "inbox" && isInboxView(model.folder)),
          unread: folder === "inbox" ? model.unreadCount : 0,
        }),
      ),
    },
    h,
  );

export const view = Submodel.defineView<Model, Message>((model, h) =>
  workspace(
    {
      className: "workspace-stacked inbox",
      ...(model.selected === null
        ? {
            title: mailboxLabels[model.folder],
            ...(isInboxView(model.folder)
              ? { titleAccessory: inboxPriorityTabs(model.folder, h) }
              : {}),
          }
        : {}),
      headerActions: [
        ...(model.selected
          ? [
              button(
                {
                  variant: "ghost",
                  size: "icon-sm",
                  rounded: true,
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
                variant: "outline",
                dialogId: model.folderSheet.id,
                onClick: Message.GotFolderSheetMessage({
                  message: Sheet.Message.RequestedOpen(),
                }),
                children: ["Folders"],
              },
              h,
            ),
          ],
        ),
        h.submodel({
          slotId: "inbox-compose",
          view: Compose.view,
          model: { ...model.compose, sender: model.list?.sender },
          toParentMessage: toComposeMessage,
        }),
      ],
      sidebar: folderNavigation(model, h),
      list: listView(model, h),
      ...(model.selected
        ? { detail: entryView(model, model.selected, h) }
        : {}),
      hasSelection: model.selected !== null,
      sheet: Sheet.sheet(
        {
          model: model.folderSheet,
          title: "Mail folders",
          content: folderNavigation(model, h),
          toParentMessage: (message) =>
            Message.GotFolderSheetMessage({ message }),
        },
        h,
      ),
    },
    h,
  ),
);
