import { Effect, Schema } from "effect";
import { Command, Submodel, Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
import {
  inboxApiPath,
  InboxEntry,
  inboxMessageApi,
  InboxMessageId,
  inboxMessagePage,
  inboxOriginalApi,
  InboxPage,
  inboxPath,
} from "./inbox-contract.ts";

const isMessageId = Schema.is(InboxMessageId);
export const messageIdFor = (pathname: string) => {
  if (!pathname.startsWith(`${inboxPath}/`)) return null;
  const id = pathname.slice(inboxPath.length + 1);
  return isMessageId(id) ? id : null;
};

export const Model = Schema.Struct({
  list: Schema.NullOr(InboxPage),
  listRequest: Schema.NullOr(Schema.String),
  listError: Schema.NullOr(Schema.String),
  selected: Schema.NullOr(InboxMessageId),
  entry: Schema.NullOr(InboxEntry),
  entryRequest: Schema.NullOr(Schema.String),
  entryError: Schema.NullOr(Schema.String),
  confirmingDelete: Schema.Boolean,
  deleteRequest: Schema.NullOr(
    Schema.Struct({ id: InboxMessageId, request: Schema.String }),
  ),
  deleteFailed: Schema.Boolean,
});
type Model = typeof Model.Type;

export const initial: Model = {
  list: null,
  listRequest: null,
  listError: null,
  selected: null,
  entry: null,
  entryRequest: null,
  entryError: null,
  confirmingDelete: false,
  deleteRequest: null,
  deleteFailed: false,
};

export const Message = defineMessageUnion({
  Opened: { id: Schema.NullOr(InboxMessageId) },
  Refreshed: {},
  RequestedMore: {},
  RetriedEntry: {},
  RequestedDelete: {},
  CanceledDelete: {},
  ConfirmedDelete: {},
  DeletedEntry: { id: InboxMessageId, request: Schema.String },
  DeleteFailed: { request: Schema.String },
  LoadedList: {
    request: Schema.String,
    page: InboxPage,
    append: Schema.Boolean,
  },
  ListFailed: { request: Schema.String },
  LoadedEntry: { request: Schema.String, entry: InboxEntry },
  EntryFailed: { request: Schema.String, missing: Schema.Boolean },
  SessionExpired: { request: Schema.String },
  FocusUpdated: {},
});
type Message = typeof Message.Type;

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
  args: { request: Schema.String, cursor: Schema.NullOr(Schema.String) },
  messages: [Message.LoadedList, Message.ListFailed, Message.SessionExpired],
  execute: ({ request, cursor }) =>
    Effect.tryPromise(async (signal) => {
      const query =
        cursor === null ? "" : `?${new URLSearchParams({ cursor })}`;
      const response = await fetch(inboxApiPath + query, {
        cache: "no-store",
        signal,
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      if (!response.ok) return Message.ListFailed({ request });
      const page = Schema.decodeUnknownSync(InboxPage)(await response.json());
      return Message.LoadedList({ request, page, append: cursor !== null });
    }).pipe(
      Effect.catch(() => Effect.succeed(Message.ListFailed({ request }))),
    ),
});

const LoadEntry = Command.define("LoadInboxEntry", {
  args: { request: Schema.String, id: InboxMessageId },
  messages: [Message.LoadedEntry, Message.EntryFailed, Message.SessionExpired],
  execute: ({ request, id }) =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(inboxMessageApi(id), {
        cache: "no-store",
        signal,
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      if (!response.ok)
        return Message.EntryFailed({
          request,
          missing: response.status === 404,
        });
      const entry = Schema.decodeUnknownSync(InboxEntry)(await response.json());
      return Message.LoadedEntry({ request, entry });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(Message.EntryFailed({ request, missing: false })),
      ),
    ),
});

const DeleteEntry = Command.define("DeleteInboxEntry", {
  args: { request: Schema.String, id: InboxMessageId },
  messages: [
    Message.DeletedEntry,
    Message.DeleteFailed,
    Message.SessionExpired,
  ],
  execute: ({ request, id }) =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(inboxMessageApi(id), {
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
    model: { ...model, listRequest: request, listError: null },
    commands: [LoadList({ request, cursor })],
  };
};

const loadEntry = (model: Model): Update.Return<Model, Message> => {
  if (!model.selected || model.entryRequest !== null) return { model };
  const request = crypto.randomUUID();
  return {
    model: { ...model, entryRequest: request, entryError: null },
    commands: [LoadEntry({ request, id: model.selected })],
  };
};

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    Opened: ({ id }) => {
      const next =
        model.selected === id
          ? { ...model, confirmingDelete: false }
          : {
              ...model,
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
    RequestedMore: () =>
      model.list?.cursor ? loadList(model, model.list.cursor) : { model },
    RetriedEntry: () => loadEntry(model),
    RequestedDelete: () =>
      model.entry && !model.deleteRequest
        ? { model: { ...model, confirmingDelete: true, deleteFailed: false } }
        : { model },
    CanceledDelete: () => ({ model: { ...model, confirmingDelete: false } }),
    ConfirmedDelete: () => {
      if (!model.confirmingDelete || !model.entry || model.deleteRequest)
        return { model };
      const deletion = { id: model.entry.id, request: crypto.randomUUID() };
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
              deleteFailed: model.selected === model.deleteRequest.id,
            },
          },
    LoadedList: ({ request, page, append }) =>
      request !== model.listRequest
        ? { model }
        : {
            model: {
              ...model,
              listRequest: null,
              list:
                append && model.list
                  ? {
                      ...page,
                      messages: [...model.list.messages, ...page.messages],
                    }
                  : page,
            },
          },
    ListFailed: ({ request }) =>
      request !== model.listRequest
        ? { model }
        : {
            model: {
              ...model,
              listError: "Could not load messages. Try again.",
              listRequest: null,
            },
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

const receivedFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const receivedTime = (h: HtmlBuilder<Message>, receivedAt: number) =>
  h.time(
    [h.Datetime(new Date(receivedAt).toISOString())],
    [receivedFormat.format(receivedAt)],
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
        [h.Class("workspace-results")],
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
                                h.Href(inboxMessagePage(message.id)),
                                ...(model.selected === message.id
                                  ? [h.AriaCurrent("page")]
                                  : []),
                              ],
                              [
                                h.strong(
                                  [],
                                  [message.subject || "(No subject)"],
                                ),
                                h.span([], [message.from || "Unknown sender"]),
                                receivedTime(h, message.receivedAt),
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
          h.a([h.Href(inboxPath)], ["Back to messages"]),
          ...(entry === null
            ? []
            : [
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
                    h.dt([], ["Received"]),
                    h.dd([], [receivedTime(h, entry.receivedAt)]),
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
            h.footer(
              [h.Class("inbox-entry-footer")],
              [
                h.a(
                  [h.Href(inboxOriginalApi(selected)), h.Download(selected)],
                  ["Download original (.eml)"],
                ),
              ],
            ),
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
      h.header([h.Class("workspace-header")], [h.h1([], ["Inbox"])]),
      h.nav(
        [h.Class("workspace-sidebar"), h.AriaLabel("Mailbox navigation")],
        [
          h.ul(
            [h.Class("workspace-nav-list")],
            [
              h.li(
                [],
                [h.a([h.Href(inboxPath), h.AriaCurrent("true")], ["Inbox"])],
              ),
            ],
          ),
        ],
      ),
      listView(model, h),
      entryView(model, h),
    ],
  ),
);
