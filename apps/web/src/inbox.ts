import { Effect, Option, Queue, Schema, Stream } from "effect";
import { Command, Submodel, Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
import * as Attachments from "./inbox-attachments.ts";
import * as Compose from "./inbox-compose.ts";
import * as QuickReply from "./inbox-inline-reply.ts";
import {
  compactMailTime,
  conversationPeople,
  conversationSubject,
  splitMailQuote,
} from "./inbox-display.ts";
import {
  archiveApiPath,
  archivePath,
  Conversation,
  type ConversationMessage,
  conversationApi,
  conversationArchiveApi,
  conversationsApiPath,
  folderApiPath,
  folderPath,
  inboxChanged,
  inboxComposeLimits,
  InboxEntry,
  inboxEventsPath,
  InboxMessageId,
  InboxPage,
  inboxPath,
  inboxReadApi,
  InboxUnread,
  inboxUnreadPath,
  MailEntry,
  MailFolder,
  MailboxView,
  MailMessageId,
  MailPage,
  type MailPerson,
  mailMessageApi,
  mailMessagePage,
  replySubject,
  SentEntry,
  SentMessageId,
  SentPage,
  sentPath,
} from "./inbox-contract.ts";
import { unreadBadge } from "./navigation.ts";
import {
  normalizePersonEmail,
  PersonEmail,
  type PersonMatch,
  type PersonSummary,
} from "./people-contract.ts";
import { avatar } from "./people.ts";

const MessageLocation = Schema.Struct({
  folder: MailFolder,
  id: MailMessageId,
});

const isInboxMessageId = Schema.is(InboxMessageId);
const isSentMessageId = Schema.is(SentMessageId);
const isPersonEmail = Schema.is(PersonEmail);
export const MailRoute = Schema.Struct({
  folder: MailboxView,
  id: Schema.NullOr(MailMessageId),
});
export const routeFor = (pathname: string): typeof MailRoute.Type | null => {
  if (pathname === inboxPath || pathname === `${inboxPath}/`)
    return { folder: "inbox", id: null };
  if (pathname === sentPath || pathname === `${sentPath}/`)
    return { folder: "sent", id: null };
  if (pathname === archivePath || pathname === `${archivePath}/`)
    return { folder: "archive", id: null };
  if (pathname.startsWith(`${sentPath}/`)) {
    const id = pathname.slice(sentPath.length + 1);
    return isSentMessageId(id) ? { folder: "sent", id } : null;
  }
  if (pathname.startsWith(`${archivePath}/`)) {
    const id = pathname.slice(archivePath.length + 1);
    return isInboxMessageId(id) ? { folder: "archive", id } : null;
  }
  if (pathname.startsWith(`${inboxPath}/`)) {
    const id = pathname.slice(inboxPath.length + 1);
    return isInboxMessageId(id) ? { folder: "inbox", id } : null;
  }
  return null;
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

const messageFolder = (view: MailboxView): MailFolder =>
  view === "sent" ? "sent" : "inbox";

export const Model = Schema.Struct({
  folder: MailboxView,
  list: Schema.NullOr(MailPage),
  listRequest: Schema.NullOr(Schema.String),
  listRefreshQueued: Schema.Boolean,
  listError: Schema.NullOr(Schema.String),
  unreadCount: Schema.Number,
  unreadRequest: Schema.NullOr(Schema.String),
  unreadRefreshQueued: Schema.Boolean,
  readRequests: Schema.Record(Schema.String, Schema.String),
  readFailed: Schema.NullOr(InboxMessageId),
  selected: Schema.NullOr(MailMessageId),
  active: Schema.NullOr(MessageLocation),
  thread: Schema.NullOr(Conversation),
  threadRequest: Schema.NullOr(Schema.String),
  threadRefreshQueued: Schema.Boolean,
  threadFailed: Schema.Boolean,
  entry: Schema.NullOr(MailEntry),
  entryRequest: Schema.NullOr(Schema.String),
  entryError: Schema.NullOr(Schema.String),
  attachmentPreview: Attachments.State,
  confirmingDelete: Schema.Boolean,
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
  compose: Compose.Model,
  quickReply: QuickReply.Model,
});
type Model = typeof Model.Type;

export const initial: Model = {
  folder: "inbox",
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
  active: null,
  thread: null,
  threadRequest: null,
  threadRefreshQueued: false,
  threadFailed: false,
  entry: null,
  entryRequest: null,
  entryError: null,
  attachmentPreview: null,
  confirmingDelete: false,
  deleteRequest: null,
  deleteFailed: false,
  archiveRequest: null,
  archiveNotice: null,
  archiveError: null,
  compose: Compose.initial,
  quickReply: QuickReply.initial,
};

export const Message = defineMessageUnion({
  Opened: MailRoute.fields,
  RetriedList: {},
  RefreshedUnread: {},
  GotComposeMessage: { message: Compose.Message },
  GotQuickReplyMessage: { message: QuickReply.Message },
  GotAttachmentMessage: { message: Attachments.Message },
  LiveChanged: {},
  RequestedMore: {},
  RetriedEntry: {},
  RetriedThread: {},
  UpdatedProfiles: {},
  ToggledUnread: {},
  ToggledMessage: MessageLocation.fields,
  RequestedBack: {},
  RequestedPerson: { address: Schema.String },
  RequestedReply: {},
  RequestedDelete: {},
  CanceledDelete: {},
  ConfirmedDelete: {},
  DeletedEntry: { id: MailMessageId, request: Schema.String },
  DeleteFailed: { request: Schema.String },
  RequestedArchiveChange: {},
  UndidArchive: {},
  ArchiveChanged: { request: Schema.String },
  ArchiveFailed: { request: Schema.String, error: Schema.String },
  LoadedList: {
    request: Schema.String,
    page: MailPage,
    append: Schema.Boolean,
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

const FocusEntry = Mount.define("FocusInboxEntry", {
  messages: [Message.FocusUpdated],
  execute: ({ element }) =>
    Effect.sync(() => {
      if (element instanceof HTMLElement)
        element.focus({ preventScroll: true });
      return Message.FocusUpdated();
    }),
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
      const path =
        folder === "archive"
          ? archiveApiPath
          : folder === "inbox"
            ? conversationsApiPath
            : folderApiPath(folder);
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
            : Schema.decodeUnknownSync(InboxPage)(payload);
        page = page
          ? { ...next, messages: [...page.messages, ...next.messages] }
          : next;
        nextCursor = page.cursor;
      } while (nextCursor && !page.indexing && page.messages.length < minimum);
      return Message.LoadedList({ request, page, append: cursor !== null });
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

const loadList = (
  model: Model,
  cursor: string | null,
): Update.Return<Model, Message> => {
  if (model.listRequest !== null) return { model };
  const request = crypto.randomUUID();
  return {
    model: {
      ...model,
      listRequest: request,
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

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    Opened: ({ id, folder }) => {
      const base =
        folder === model.folder
          ? model
          : {
              ...initial,
              folder,
              compose: model.compose,
              quickReply: model.quickReply,
              deleteRequest: model.deleteRequest,
              archiveRequest: model.archiveRequest,
              archiveNotice: model.archiveNotice,
              unreadCount: model.unreadCount,
              unreadRequest: model.unreadRequest,
              unreadRefreshQueued: model.unreadRefreshQueued,
              readRequests: model.readRequests,
            };
      const next =
        base.selected === id
          ? { ...base, confirmingDelete: false }
          : {
              ...base,
              selected: id,
              active: id ? { id, folder: messageFolder(folder) } : null,
              thread: null,
              threadRequest: null,
              threadRefreshQueued: false,
              threadFailed: false,
              entry: null,
              entryRequest: null,
              entryError: null,
              attachmentPreview: null,
              confirmingDelete: false,
              deleteFailed: false,
            };
      const list = id && next.list ? { model: next } : loadList(next, null);
      return next.thread ? list : withThread(list);
    },
    RetriedList: () => withUnread(withThread(loadList(model, null))),
    GotAttachmentMessage: ({ message }) => foldAttachments(model, message),
    RefreshedUnread: () => refreshUnread(model),
    GotComposeMessage: ({ message }) => {
      const result = foldCompose(model, message);
      if (
        message._tag !== "Sent" ||
        model.compose.request !== message.request ||
        !message.saved
      )
        return result;
      return withThread(refreshList(result.model));
    },
    GotQuickReplyMessage: ({ message }) => {
      const result = foldQuickReply(model, message);
      return message._tag === "Sent" &&
        message.request === model.quickReply.request &&
        message.saved
        ? withThread(refreshList(result.model))
        : result;
    },
    LiveChanged: () =>
      withUnread(
        withThread(model.folder !== "sent" ? refreshList(model) : { model }),
      ),
    RequestedMore: () =>
      model.list?.cursor && !model.list.indexing
        ? loadList(model, model.list.cursor)
        : { model },
    RetriedEntry: () => loadEntry(model),
    RetriedThread: () => refreshThread(model),
    UpdatedProfiles: () =>
      withThread(model.folder !== "sent" ? refreshList(model) : { model }),
    RequestedArchiveChange: () => {
      if (model.archiveRequest || model.folder === "sent" || !model.thread)
        return { model };
      const newest = model.thread.messages.findLast(
        ({ folder }) => folder === "inbox",
      );
      if (!newest) return { model };
      return changeArchive(
        model,
        { id: newest.id, archived: !model.thread.archived },
        model.selected,
      );
    },
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
      const removesRow =
        model.folder === (change.archived ? "inbox" : "archive");
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
    ToggledUnread: () => {
      const entry = model.entry;
      return entry && "receivedAt" in entry
        ? setUnread(model, entry.id, !entryUnread(model))
        : { model };
    },
    ToggledMessage: ({ id, folder }) =>
      loadEntry({
        ...model,
        active: model.active?.id === id ? null : { id, folder },
        entry: null,
        entryRequest: null,
        entryError: null,
        attachmentPreview: null,
        deleteFailed: false,
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
    RequestedDelete: () =>
      model.entry && !model.deleteRequest
        ? { model: { ...model, confirmingDelete: true, deleteFailed: false } }
        : { model },
    CanceledDelete: () => ({ model: { ...model, confirmingDelete: false } }),
    ConfirmedDelete: () => {
      if (
        !model.confirmingDelete ||
        !model.entry ||
        !model.active ||
        model.deleteRequest
      )
        return { model };
      const deletion = {
        id: model.entry.id,
        request: crypto.randomUUID(),
        folder: model.active.folder,
      };
      return {
        model: { ...model, confirmingDelete: false, deleteRequest: deletion },
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
              active:
                model.selected && model.selected !== id
                  ? { id: model.selected, folder: messageFolder(model.folder) }
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
              deleteFailed: model.active?.id === model.deleteRequest.id,
            },
          },
    LoadedList: ({ request, page, append }) => {
      if (request !== model.listRequest) return { model };
      const next = {
        ...model,
        listRequest: null,
        list:
          append && model.list
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
      if (request !== model.listRequest) return { model };
      const next = {
        ...model,
        listRequest: null,
        listError: "Could not load messages. Try again.",
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
const messageTime = (h: HtmlBuilder<Message>, time: number) =>
  h.time(
    [h.Datetime(new Date(time).toISOString())],
    [messageDateFormat.format(time)],
  );

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

const conversationRow = (
  message: (typeof InboxPage.Type.messages)[number],
  h: HtmlBuilder<Message>,
) => {
  const participants = groupParticipants(
    message.participants ??
      (message.from ? [{ address: message.from, name: "" }] : []),
    findProfiles(message.profiles),
  );
  const timestamp = message.lastMessageAt ?? message.receivedAt;
  const count = message.messageCount ?? 1;
  const countLabel = `${count} ${count === 1 ? "message" : "messages"}${message.unreadCount ? `, ${message.unreadCount} unread` : ""}`;
  return [
    h.div(
      [h.Class("inbox-conversation-summary")],
      [
        h.strong([], [conversationSubject([message])]),
        h.span(
          [
            h.Class("inbox-conversation-count"),
            h.Title(countLabel),
            h.Role("img"),
            h.AriaLabel(countLabel),
          ],
          [String(count)],
        ),
        h.time(
          [
            h.Datetime(new Date(timestamp).toISOString()),
            h.Title(messageDateFormat.format(timestamp)),
          ],
          [compactMailTime(timestamp)],
        ),
      ],
    ),
    ...(participants.length
      ? [
          h.div(
            [h.Class("inbox-list-avatars")],
            participants.map(
              ([
                key,
                {
                  addresses: [address, ...aliases],
                  name,
                  person,
                },
              ]) => {
                const tooltip = participantTooltip(name, address, aliases);
                return h.span(
                  [
                    h.Key(key),
                    h.Title(tooltip),
                    h.Role("img"),
                    h.AriaLabel(tooltip),
                  ],
                  [avatar(h, person, address, name)],
                );
              },
            ),
          ),
        ]
      : []),
  ];
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
                  ? "Conversation archived."
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

const listView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [h.Class("workspace-list inbox-list"), h.AriaLabel("Messages")],
    [
      ...(model.selected === null ? archiveFeedback(model, h) : []),
      h.div(
        [h.Key(model.folder), h.Class("workspace-results")],
        [
          ...(model.listRequest === null
            ? []
            : [
                h.p(
                  [h.Class("inbox-status"), h.Role("status")],
                  ["Loading messages…"],
                ),
              ]),
          ...(model.listError === null
            ? []
            : [
                h.div(
                  [h.Class("inbox-status")],
                  [
                    h.p([h.Role("alert")], [model.listError]),
                    h.button(
                      [h.Type("button"), h.OnClick(Message.RetriedList())],
                      ["Retry"],
                    ),
                  ],
                ),
              ]),
          ...(model.list?.indexing
            ? [
                h.p(
                  [h.Class("inbox-status"), h.Role("status")],
                  ["Organizing existing mail…"],
                ),
              ]
            : []),
          ...(model.list === null
            ? []
            : [
                model.list.messages.length === 0 &&
                model.list.cursor === null &&
                !model.list.indexing &&
                model.listRequest === null
                  ? h.p(
                      [h.Class("inbox-status")],
                      [
                        model.folder === "archive"
                          ? "No archived conversations."
                          : "No messages yet.",
                      ],
                    )
                  : h.ul(
                      [h.Class("inbox-messages")],
                      model.list.messages.map((message) => {
                        const unread =
                          "receivedAt" in message &&
                          Boolean(message.unreadCount);
                        return h.li(
                          [h.Key(message.id)],
                          [
                            h.a(
                              [
                                h.Class(
                                  unread
                                    ? "inbox-message-row is-unread"
                                    : "inbox-message-row",
                                ),
                                h.Href(
                                  mailMessagePage(model.folder, message.id),
                                ),
                                ...(model.selected === message.id ||
                                (model.folder !== "sent" &&
                                  model.thread?.messages.some(
                                    ({ id }) => id === message.id,
                                  ))
                                  ? [h.AriaCurrent("page")]
                                  : []),
                              ],
                              "sentAt" in message
                                ? [
                                    h.strong(
                                      [],
                                      [message.subject || "(No subject)"],
                                    ),
                                    h.span(
                                      [],
                                      [message.to || "Unknown recipient"],
                                    ),
                                    messageTime(h, message.sentAt),
                                  ]
                                : conversationRow(message, h),
                            ),
                          ],
                        );
                      }),
                    ),
                ...(model.list.cursor === null || model.list.indexing
                  ? []
                  : [
                      h.div(
                        [h.Class("inbox-list-footer")],
                        [
                          h.button(
                            [
                              h.Type("button"),
                              h.Disabled(model.listRequest !== null),
                              h.OnClick(Message.RequestedMore()),
                            ],
                            ["Load more"],
                          ),
                        ],
                      ),
                    ]),
              ]),
        ],
      ),
    ],
  );

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
  return [
    ...(entry && model.readFailed === entry.id
      ? [h.p([h.Role("alert")], ["Could not update read status. Try again."])]
      : []),
    ...(model.deleteFailed
      ? [h.p([h.Role("alert")], ["Could not confirm the deletion. Try again."])]
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
          ...(entry.text
            ? [
                h.div(
                  [h.Class("inbox-body")],
                  splitMailQuote(entry.text).map(({ text, quoted }, index) =>
                    quoted
                      ? h.details(
                          [h.Key(String(index)), h.Class("inbox-quote")],
                          [
                            h.summary(
                              [],
                              [
                                h.span(
                                  [h.Class("inbox-quote-closed")],
                                  ["Show quoted text"],
                                ),
                                h.span(
                                  [h.Class("inbox-quote-open")],
                                  ["Hide quoted text"],
                                ),
                              ],
                            ),
                            h.blockquote([], [text]),
                          ],
                        )
                      : h.div(
                          [h.Key(String(index)), h.Class("inbox-body-part")],
                          [text],
                        ),
                  ),
                ),
              ]
            : []),
          ...(entry.preview !== "complete" || !entry.text
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
          h.div(
            [h.Class("inbox-toolbar-actions")],
            [
              ...("receivedAt" in entry && entry.reply && model.list?.sender
                ? [
                    h.button(
                      [h.Type("button"), h.OnClick(Message.RequestedReply())],
                      ["Reply"],
                    ),
                  ]
                : []),
              ...("receivedAt" in entry
                ? [
                    h.button(
                      [
                        h.Type("button"),
                        h.Disabled(Boolean(model.readRequests[entry.id])),
                        h.OnClick(Message.ToggledUnread()),
                      ],
                      [entryUnread(model) ? "Mark read" : "Mark unread"],
                    ),
                  ]
                : []),
              h.button(
                [
                  h.Type("button"),
                  h.Class("inbox-delete-button"),
                  h.Disabled(model.deleteRequest !== null),
                  h.OnClick(Message.RequestedDelete()),
                ],
                [model.deleteRequest?.id === entry.id ? "Deleting…" : "Delete"],
              ),
            ],
          ),
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
          h.OnClick(Message.RequestedPerson({ address })),
        ],
        [picture],
      )
    : h.span(
        [h.Title(tooltip), h.Role("img"), h.AriaLabel(tooltip)],
        [picture],
      );
};

const entryView = (model: Model, h: HtmlBuilder<Message>) => {
  const { selected, active } = model;
  if (!selected)
    return h.div([h.Class("workspace-detail")], ["Select a message to read."]);
  const messages = readerMessages(model);
  const participants = conversationPeople(messages);
  const profiles = findProfiles(model.thread?.profiles);
  const participantAvatars = groupParticipants(participants, profiles);
  const latest = messages.at(-1);
  const grouped = messages.length > 1;
  const canArchive =
    model.folder !== "sent" &&
    model.thread?.messages.some(({ folder }) => folder === "inbox");
  return h.article(
    [
      h.Key(selected),
      h.Class("workspace-detail inbox-reader"),
      h.AriaLabel("Message"),
      h.Tabindex(-1),
      h.OnMount(FocusEntry()),
    ],
    [
      h.div(
        [h.Class("inbox-toolbar")],
        [
          h.button(
            [h.Type("button"), h.OnClick(Message.RequestedBack())],
            ["Back"],
          ),
          ...(canArchive
            ? [
                h.button(
                  [
                    h.Type("button"),
                    h.Disabled(model.archiveRequest !== null),
                    h.OnClick(Message.RequestedArchiveChange()),
                  ],
                  [model.thread?.archived ? "Move to Inbox" : "Archive"],
                ),
              ]
            : []),
        ],
      ),
      ...archiveFeedback(model, h),
      ...(model.confirmingDelete ? [deleteDialog(h)] : []),
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
                h.h2([], [conversationSubject(messages)]),
                ...(participantAvatars.length
                  ? [
                      h.ul(
                        [
                          h.Class("inbox-participant-avatars"),
                          h.AriaLabel("Participant profiles"),
                        ],
                        participantAvatars.map(
                          ([
                            key,
                            {
                              addresses: [address, ...aliases],
                              name,
                              person,
                            },
                          ]) =>
                            h.li(
                              [h.Key(key)],
                              [
                                profileAvatar(h, {
                                  address,
                                  person,
                                  name,
                                  aliases,
                                  editLabel: `Edit participant profile for ${address}`,
                                }),
                              ],
                            ),
                        ),
                      ),
                    ]
                  : []),
              ],
            ),
            h.ol(
              [h.Class("inbox-thread"), h.AriaLabel("Conversation messages")],
              messages.map((message) => {
                const { id, folder, from, timestamp, unread } = message;
                const sender = message.people?.sender;
                const address = sender?.address || from;
                const person = profiles.get(normalizePersonEmail(address));
                const date = messageDateFormat.format(timestamp);
                const expanded = active?.id === id;
                const panel = `mail-content-${id}`;
                const header = [
                  ...(unread
                    ? [h.span([h.Class("inbox-thread-unread")], ["Unread"])]
                    : []),
                  h.time(
                    [
                      h.Datetime(new Date(timestamp).toISOString()),
                      h.Title(date),
                    ],
                    [compactMailTime(timestamp)],
                  ),
                ];
                return h.li(
                  [h.Key(id)],
                  [
                    h.div(
                      [h.Class("inbox-message-heading")],
                      [
                        profileAvatar(h, {
                          address,
                          person,
                          name: person?.name || sender?.name || "",
                          editLabel: `Edit profile for ${address}`,
                        }),
                        grouped
                          ? h.button(
                              [
                                h.Type("button"),
                                h.Class("inbox-thread-summary"),
                                h.AriaLabel(
                                  `Message from ${address || "unknown sender"}, ${date}${unread ? ", unread" : ""}`,
                                ),
                                h.AriaExpanded(expanded),
                                ...(expanded ? [h.AriaControls(panel)] : []),
                                h.OnClick(
                                  Message.ToggledMessage({ id, folder }),
                                ),
                              ],
                              header,
                            )
                          : h.header([h.Class("inbox-thread-summary")], header),
                      ],
                    ),
                    ...(expanded
                      ? [
                          h.section(
                            [h.Id(panel), h.Class("inbox-thread-content")],
                            entryContent(model, h),
                          ),
                        ]
                      : []),
                  ],
                );
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
              },
              toParentMessage: toQuickReplyMessage,
            }),
          ]
        : []),
    ],
  );
};

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.div(
    [
      h.Class("workspace inbox"),
      ...(model.selected === null ? [] : [h.DataAttribute("panel", "")]),
    ],
    [
      h.header(
        [h.Class("workspace-header")],
        [
          h.h1(
            [],
            [
              model.folder === "archive"
                ? "Archive"
                : model.folder === "sent"
                  ? "Sent"
                  : "Inbox",
            ],
          ),
          h.submodel({
            slotId: "inbox-compose",
            view: Compose.view,
            model: { ...model.compose, sender: model.list?.sender },
            toParentMessage: toComposeMessage,
          }),
        ],
      ),
      h.nav(
        [h.Class("workspace-sidebar"), h.AriaLabel("Mailbox navigation")],
        [
          h.ul(
            [h.Class("workspace-nav-list")],
            (
              [
                { folder: "inbox", label: "Inbox" },
                { folder: "sent", label: "Sent" },
                { folder: "archive", label: "Archive" },
              ] as const
            ).map(({ folder, label }) => {
              const count = folder === "inbox" ? model.unreadCount : 0;
              return h.li(
                [h.Key(folder)],
                [
                  h.a(
                    [
                      h.Href(folderPath(folder)),
                      ...(count
                        ? [h.AriaLabel(`${label}, ${count} unread`)]
                        : []),
                      ...(model.folder === folder
                        ? [h.AriaCurrent("true")]
                        : []),
                    ],
                    [label, ...(count ? [unreadBadge(h, count)] : [])],
                  ),
                ],
              );
            }),
          ),
        ],
      ),
      listView(model, h),
      entryView(model, h),
    ],
  ),
);
