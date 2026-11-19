import { Effect, Option, Queue, Schema, Stream } from "effect";
import { Command, Submodel, Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
import * as Compose from "./inbox-compose.ts";
import {
  Conversation,
  conversationApi,
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
  MailEntry,
  MailFolder,
  MailMessageId,
  MailPage,
  mailMessageApi,
  mailMessagePage,
  SentEntry,
  SentMessageId,
  SentPage,
  sentPath,
} from "./inbox-contract.ts";

const MessageLocation = Schema.Struct({
  folder: MailFolder,
  id: MailMessageId,
});

const isInboxMessageId = Schema.is(InboxMessageId);
const isSentMessageId = Schema.is(SentMessageId);
export const MailRoute = Schema.Struct({
  folder: MailFolder,
  id: Schema.NullOr(MailMessageId),
});
export const routeFor = (pathname: string): typeof MailRoute.Type | null => {
  if (pathname === inboxPath || pathname === `${inboxPath}/`)
    return { folder: "inbox", id: null };
  if (pathname === sentPath || pathname === `${sentPath}/`)
    return { folder: "sent", id: null };
  if (pathname.startsWith(`${sentPath}/`)) {
    const id = pathname.slice(sentPath.length + 1);
    return isSentMessageId(id) ? { folder: "sent", id } : null;
  }
  if (pathname.startsWith(`${inboxPath}/`)) {
    const id = pathname.slice(inboxPath.length + 1);
    return isInboxMessageId(id) ? { folder: "inbox", id } : null;
  }
  return null;
};

export const Model = Schema.Struct({
  folder: MailFolder,
  list: Schema.NullOr(MailPage),
  listRequest: Schema.NullOr(Schema.String),
  listRefreshQueued: Schema.Boolean,
  listError: Schema.NullOr(Schema.String),
  selected: Schema.NullOr(MailMessageId),
  active: Schema.NullOr(MessageLocation),
  thread: Schema.NullOr(Conversation),
  threadRequest: Schema.NullOr(Schema.String),
  threadRefreshQueued: Schema.Boolean,
  threadFailed: Schema.Boolean,
  entry: Schema.NullOr(MailEntry),
  entryRequest: Schema.NullOr(Schema.String),
  entryError: Schema.NullOr(Schema.String),
  confirmingDelete: Schema.Boolean,
  deleteRequest: Schema.NullOr(
    Schema.Struct({
      id: MailMessageId,
      request: Schema.String,
      folder: MailFolder,
    }),
  ),
  deleteFailed: Schema.Boolean,
  compose: Compose.Model,
});
type Model = typeof Model.Type;

export const initial: Model = {
  folder: "inbox",
  list: null,
  listRequest: null,
  listRefreshQueued: false,
  listError: null,
  selected: null,
  active: null,
  thread: null,
  threadRequest: null,
  threadRefreshQueued: false,
  threadFailed: false,
  entry: null,
  entryRequest: null,
  entryError: null,
  confirmingDelete: false,
  deleteRequest: null,
  deleteFailed: false,
  compose: Compose.initial,
};

export const Message = defineMessageUnion({
  Opened: MailRoute.fields,
  Refreshed: {},
  GotComposeMessage: { message: Compose.Message },
  LiveChanged: {},
  RequestedMore: {},
  RetriedEntry: {},
  RetriedThread: {},
  ToggledMessage: MessageLocation.fields,
  RequestedBack: {},
  RequestedReply: {},
  RequestedDelete: {},
  CanceledDelete: {},
  ConfirmedDelete: {},
  DeletedEntry: { id: MailMessageId, request: Schema.String },
  DeleteFailed: { request: Schema.String },
  LoadedList: {
    request: Schema.String,
    page: MailPage,
    append: Schema.Boolean,
  },
  ListFailed: { request: Schema.String },
  LoadedThread: { request: Schema.String, thread: Conversation },
  ThreadFailed: { request: Schema.String },
  LoadedEntry: { request: Schema.String, entry: MailEntry },
  EntryFailed: { request: Schema.String, missing: Schema.Boolean },
  SessionExpired: { request: Schema.String },
  FocusUpdated: {},
});
type Message = typeof Message.Type;

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
    folder: MailFolder,
  },
  messages: [Message.LoadedList, Message.ListFailed, Message.SessionExpired],
  execute: ({ request, cursor, folder }) =>
    Effect.tryPromise(async (signal) => {
      const query =
        cursor === null ? "" : `?${new URLSearchParams({ cursor })}`;
      const path =
        folder === "inbox" ? conversationsApiPath : folderApiPath(folder);
      const response = await fetch(path + query, {
        cache: "no-store",
        signal,
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      if (!response.ok) return Message.ListFailed({ request });
      const payload = await response.json();
      const page =
        folder === "sent"
          ? Schema.decodeUnknownSync(SentPage)(payload)
          : Schema.decodeUnknownSync(InboxPage)(payload);
      return Message.LoadedList({ request, page, append: cursor !== null });
    }).pipe(
      Effect.catch(() => Effect.succeed(Message.ListFailed({ request }))),
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
    commands: [LoadList({ request, cursor, folder: model.folder })],
  };
};

const refreshList = (model: Model): Update.Return<Model, Message> =>
  model.listRequest
    ? { model: { ...model, listRefreshQueued: true } }
    : loadList(model, null);

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

const replySubject = (original: string) => {
  const subject = original.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
  const reply = /^re:/iu.test(subject) ? subject : `Re: ${subject}`;
  return reply
    .slice(0, inboxComposeLimits.subject)
    .replace(/[\uD800-\uDBFF]$/u, "")
    .trimEnd();
};

const quoteMessage = (entry: typeof InboxEntry.Type) => {
  const body = entry.text.trimEnd();
  if (!body) return "";
  const quote = body.replace(/\r\n?/gu, "\n").replace(/^/gmu, "> ");
  const limit = Math.floor(inboxComposeLimits.text / 2);
  const clipped = quote.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "");
  const from =
    entry.from
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
              deleteRequest: model.deleteRequest,
            };
      const next =
        base.selected === id
          ? { ...base, confirmingDelete: false }
          : {
              ...base,
              selected: id,
              active: id ? { id, folder } : null,
              thread: null,
              threadRequest: null,
              threadRefreshQueued: false,
              threadFailed: false,
              entry: null,
              entryRequest: null,
              entryError: null,
              confirmingDelete: false,
              deleteFailed: false,
            };
      const list = next.list ? { model: next } : loadList(next, null);
      return next.thread ? list : withThread(list);
    },
    Refreshed: () => withThread(loadList(model, null)),
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
    LiveChanged: () =>
      withThread(model.folder === "inbox" ? refreshList(model) : { model }),
    RequestedMore: () =>
      model.list?.cursor && !model.list.indexing
        ? loadList(model, model.list.cursor)
        : { model },
    RetriedEntry: () => loadEntry(model),
    RetriedThread: () => refreshThread(model),
    ToggledMessage: ({ id, folder }) =>
      loadEntry({
        ...model,
        active: model.active?.id === id ? null : { id, folder },
        entry: null,
        entryRequest: null,
        entryError: null,
        deleteFailed: false,
      }),
    RequestedBack: () => ({ model }),
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
                  ? { id: model.selected, folder: model.folder }
                  : null,
              entry: null,
              entryRequest: null,
              entryError: null,
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
      return model.selected === id ? command : withThread(command);
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
    LoadedThread: ({ request, thread }) => {
      if (request !== model.threadRequest) return { model };
      const newestIncoming = thread.messages.findLast(
        ({ folder }) => folder === "inbox",
      );
      const latest =
        !model.thread &&
        !model.entry &&
        !model.entryRequest &&
        model.folder === "inbox" &&
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
    LoadedEntry: ({ request, entry }) =>
      request !== model.entryRequest
        ? { model }
        : { model: { ...model, entry, entryRequest: null } },
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

const listView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [h.Class("workspace-list inbox-list"), h.AriaLabel("Messages")],
    [
      h.header(
        [h.Class("workspace-list-header inbox-list-header")],
        [
          h.p([], [model.list?.address ?? "Messages"]),
          h.button(
            [
              h.Type("button"),
              h.Disabled(model.listRequest !== null),
              h.OnClick(Message.Refreshed()),
            ],
            [model.list === null && model.listError ? "Retry" : "Refresh"],
          ),
        ],
      ),
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
                h.p(
                  [h.Class("inbox-status"), h.Role("alert")],
                  [model.listError],
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
                  ? h.p([h.Class("inbox-status")], ["No messages yet."])
                  : h.ul(
                      [h.Class("inbox-messages")],
                      model.list.messages.map((message) =>
                        h.li(
                          [h.Key(message.id)],
                          [
                            h.a(
                              [
                                h.Href(
                                  mailMessagePage(model.folder, message.id),
                                ),
                                ...(model.selected === message.id ||
                                (model.folder === "inbox" &&
                                  model.thread?.messages.some(
                                    ({ id }) => id === message.id,
                                  ))
                                  ? [h.AriaCurrent("page")]
                                  : []),
                              ],
                              [
                                h.strong(
                                  [],
                                  [message.subject || "(No subject)"],
                                ),
                                "sentAt" in message
                                  ? h.span(
                                      [],
                                      [message.to || "Unknown recipient"],
                                    )
                                  : h.span(
                                      [],
                                      [message.from || "Unknown sender"],
                                    ),
                                ...("messageCount" in message &&
                                (message.messageCount ?? 0) > 1
                                  ? [
                                      h.span(
                                        [],
                                        [`${message.messageCount} messages`],
                                      ),
                                    ]
                                  : []),
                                messageTime(
                                  h,
                                  "sentAt" in message
                                    ? message.sentAt
                                    : message.receivedAt,
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
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

const entryContent = (
  model: Model,
  h: HtmlBuilder<Message>,
  showSubject = true,
) => {
  const { entry } = model;
  return [
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
          h.header(
            [h.Class("inbox-entry-header")],
            [
              ...(showSubject
                ? [h.h2([], [entry.subject || "(No subject)"])]
                : []),
              h.dl(
                [],
                [
                  h.dt([], ["From"]),
                  h.dd([], [entry.from || "Unknown sender"]),
                  ...(entry.to ? [h.dt([], ["To"]), h.dd([], [entry.to])] : []),
                  h.dt([], ["sentAt" in entry ? "Sent" : "Received"]),
                  h.dd(
                    [],
                    [
                      messageTime(
                        h,
                        "sentAt" in entry ? entry.sentAt : entry.receivedAt,
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
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
          ...(entry.text ? [h.div([h.Class("inbox-body")], [entry.text])] : []),
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
        ]
      : []),
  ];
};

const entryView = (model: Model, h: HtmlBuilder<Message>) => {
  const { selected, active } = model;
  if (!selected)
    return h.div([h.Class("workspace-detail")], ["Select a message to read."]);
  const messages = model.thread?.messages ?? [];
  const grouped = messages.length > 1;
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
        ],
      ),
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
      ...(grouped
        ? [
            h.ol(
              [h.Class("inbox-thread"), h.AriaLabel("Conversation messages")],
              messages.map(({ id, folder, from, to, timestamp, subject }) => {
                const expanded = active?.id === id;
                const panel = `mail-content-${id}`;
                const participant =
                  folder === "sent" ? `To ${to}` : from || "Unknown sender";
                return h.li(
                  [h.Key(id)],
                  [
                    h.button(
                      [
                        h.Type("button"),
                        h.Class("inbox-thread-summary"),
                        h.AriaExpanded(expanded),
                        ...(expanded ? [h.AriaControls(panel)] : []),
                        h.OnClick(Message.ToggledMessage({ id, folder })),
                      ],
                      [
                        h.strong([], [subject || "(No subject)"]),
                        h.span([], [participant]),
                        messageTime(h, timestamp),
                      ],
                    ),
                    ...(expanded
                      ? [
                          h.section(
                            [h.Id(panel), h.Class("inbox-thread-content")],
                            entryContent(model, h, false),
                          ),
                        ]
                      : []),
                  ],
                );
              }),
            ),
            ...(active && !messages.some(({ id }) => id === active.id)
              ? entryContent(model, h)
              : []),
          ]
        : entryContent(model, h)),
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
          h.h1([], [model.folder === "sent" ? "Sent" : "Inbox"]),
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
              ] as const
            ).map(({ folder, label }) =>
              h.li(
                [h.Key(folder)],
                [
                  h.a(
                    [
                      h.Href(folderPath(folder)),
                      ...(model.folder === folder
                        ? [h.AriaCurrent("true")]
                        : []),
                    ],
                    [label],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
      listView(model, h),
      entryView(model, h),
    ],
  ),
);
