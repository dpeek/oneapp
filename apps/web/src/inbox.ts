import { Effect, Option, Queue, Schema, Stream } from "effect";
import { Command, Submodel, Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
import * as Compose from "./inbox-compose.ts";
import {
  folderApiPath,
  folderPath,
  inboxChanged,
  inboxComposeLimits,
  InboxEntry,
  inboxEventsPath,
  InboxMessageId,
  inboxOriginalApi,
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
      const response = await fetch(folderApiPath(folder) + query, {
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
  if (!model.selected || model.entryRequest !== null) return { model };
  const request = crypto.randomUUID();
  return {
    model: { ...model, entryRequest: request, entryError: null },
    commands: [
      LoadEntry({ request, id: model.selected, folder: model.folder }),
    ],
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
              entry: null,
              entryRequest: null,
              entryError: null,
              confirmingDelete: false,
              deleteFailed: false,
            };
      const list = next.list ? { model: next } : loadList(next, null);
      const entry = next.entry ? { model: list.model } : loadEntry(list.model);
      return {
        model: entry.model,
        commands: [...(list.commands ?? []), ...(entry.commands ?? [])],
      };
    },
    Refreshed: () => loadList(model, null),
    GotComposeMessage: ({ message }) => {
      const result = foldCompose(model, message);
      return message._tag === "Sent" &&
        model.compose.request === message.request &&
        model.folder === "sent"
        ? refreshList(result.model)
        : result;
    },
    LiveChanged: () =>
      model.folder === "inbox" ? refreshList(model) : { model },
    RequestedMore: () =>
      model.list?.cursor ? loadList(model, model.list.cursor) : { model },
    RetriedEntry: () => loadEntry(model),
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
      if (!model.confirmingDelete || !model.entry || model.deleteRequest)
        return { model };
      const deletion = {
        id: model.entry.id,
        request: crypto.randomUUID(),
        folder: model.folder,
      };
      return {
        model: { ...model, confirmingDelete: false, deleteRequest: deletion },
        commands: [DeleteEntry(deletion)],
      };
    },
    DeletedEntry: ({ id, request }) => {
      if (request !== model.deleteRequest?.request) return { model };
      if (model.deleteRequest.folder !== model.folder)
        return { model: { ...model, deleteRequest: null } };
      const list = model.list && {
        ...model.list,
        messages: model.list.messages.filter((message) => message.id !== id),
      };
      const next = {
        ...model,
        list,
        listRequest: null,
        deleteRequest: null,
        ...(model.selected === id
          ? { entry: null, entryRequest: null, entryError: null }
          : {}),
      };
      // An overlapping list request may contain a snapshot from before deletion.
      return model.listRequest || !list
        ? loadList(next, null)
        : { model: next };
    },
    DeleteFailed: ({ request }) =>
      request !== model.deleteRequest?.request
        ? { model }
        : {
            model: {
              ...model,
              deleteRequest: null,
              deleteFailed:
                model.folder === model.deleteRequest.folder &&
                model.selected === model.deleteRequest.id,
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
      return next.listRefreshQueued ? loadList(next, null) : { model: next };
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
          ...(model.list === null
            ? []
            : [
                model.list.messages.length === 0 &&
                model.list.cursor === null &&
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
                                ...(model.selected === message.id
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
                ...(model.list.cursor === null
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
  truncated:
    "This preview is shortened. Download the original to read the full message.",
  tooLarge:
    "This message is too large to preview. You can download the original.",
  unreadable:
    "This message could not be previewed. You can download the original.",
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

const entryView = (model: Model, h: HtmlBuilder<Message>) => {
  const { entry, selected } = model;
  if (!selected)
    return h.div([h.Class("workspace-detail")], ["Select a message to read."]);
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
          h.a([h.Href(folderPath(model.folder))], ["Back to messages"]),
          ...(entry === null
            ? []
            : [
                h.div(
                  [h.Class("inbox-toolbar-actions")],
                  [
                    ...("receivedAt" in entry &&
                    entry.reply &&
                    model.list?.sender
                      ? [
                          h.button(
                            [
                              h.Type("button"),
                              h.OnClick(Message.RequestedReply()),
                            ],
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
                      [
                        model.deleteRequest?.id === selected
                          ? "Deleting…"
                          : "Delete",
                      ],
                    ),
                  ],
                ),
              ]),
        ],
      ),
      ...(model.confirmingDelete ? [deleteDialog(h)] : []),
      ...(model.deleteFailed
        ? [
            h.p(
              [h.Role("alert")],
              ["Could not confirm the deletion. Try again."],
            ),
          ]
        : []),
      ...(model.entryRequest === null
        ? []
        : [h.p([h.Role("status")], ["Opening message…"])]),
      ...(model.entryError === null
        ? []
        : [
            h.p([h.Role("alert")], [model.entryError]),
            h.button(
              [h.Type("button"), h.OnClick(Message.RetriedEntry())],
              ["Retry"],
            ),
          ]),
      ...(entry === null
        ? []
        : [
            h.header(
              [h.Class("inbox-entry-header")],
              [
                h.h2([], [entry.subject || "(No subject)"]),
                h.dl(
                  [],
                  [
                    h.dt([], ["From"]),
                    h.dd([], [entry.from || "Unknown sender"]),
                    ...(entry.to
                      ? [h.dt([], ["To"]), h.dd([], [entry.to])]
                      : []),
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
            ...(entry.text
              ? [h.div([h.Class("inbox-body")], [entry.text])]
              : []),
            ...(entry.preview === "complete"
              ? entry.text
                ? []
                : [
                    h.p(
                      [h.Class("inbox-preview")],
                      ["This message has no text body."],
                    ),
                  ]
              : [
                  h.p(
                    [h.Class("inbox-preview")],
                    [previewNotice[entry.preview]],
                  ),
                ]),
            ...("receivedAt" in entry
              ? [
                  h.footer(
                    [h.Class("inbox-entry-footer")],
                    [
                      h.a(
                        [
                          h.Href(inboxOriginalApi(selected)),
                          h.Download(selected),
                        ],
                        ["Download original (.eml)"],
                      ),
                    ],
                  ),
                ]
              : []),
          ]),
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
