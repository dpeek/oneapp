import { Link, LinkList } from "@orumai/core/links";
import {
  alert,
  avatar,
  button,
  buttonGroup,
  Dialog,
  field,
  input,
  item,
  itemGroup,
  outlineIcon,
  plusIcon,
  trashIconPaths,
} from "@orumai/ui";
import { Effect, Schema } from "effect";
import { Command, Mount, Submodel, type Update } from "foldkit";
import type { ChildAttribute, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import {
  deleteLink,
  parseLinkInput,
  readLinks,
  saveLink,
} from "./links-client.ts";
import { Notification } from "./notifications.ts";
import { websiteIconHostname, websiteIconPath } from "./website-icon-host.ts";
import { screenHeader } from "./workspace.ts";

export const creationUrlId = "create-link-url";
const creationErrorId = `${creationUrlId}-error`;
const invalidUrl = "Enter a valid HTTP or HTTPS URL without credentials.";
const LinkDraft = Schema.Struct({
  url: Schema.String,
  validationError: Schema.NullOr(Schema.String),
});

export const Model = Schema.Struct({
  records: Schema.NullOr(LinkList),
  ...LinkDraft.fields,
  creation: Schema.NullOr(
    Schema.Struct({
      ...LinkDraft.fields,
      saveError: Schema.NullOr(Schema.String),
    }),
  ),
  request: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.Literals(["load", "save", "create", "delete"]),
      linkId: Schema.NullOr(Schema.String),
    }),
  ),
  loadError: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;
export const initial: Model = {
  records: null,
  url: "",
  creation: null,
  request: null,
  validationError: null,
  loadError: null,
};
export const Message = defineMessageUnion({
  Requested: {},
  Retried: {},
  EditedUrl: { url: Schema.String },
  Submitted: {},
  OpenedCreate: {},
  EditedCreateUrl: { url: Schema.String },
  SubmittedCreate: {},
  ClosedCreate: {},
  RequestedDeletion: { id: Schema.String },
  Loaded: { request: Schema.String, links: LinkList },
  Saved: { request: Schema.String, link: Link },
  Deleted: { request: Schema.String, id: Schema.String },
  Failed: { request: Schema.String, error: Schema.String },
  SessionExpired: { request: Schema.String },
  FocusedLinkInput: {},
  CompletedLinkAvatarImageMount: {},
});
export type Message = typeof Message.Type;
export const OutMessage = defineMessageUnion({
  Notify: { notification: Notification },
  DismissNotification: { key: Schema.String },
  Created: {},
  SessionExpired: {},
});
export type OutMessage = typeof OutMessage.Type;

const Load = Command.define("LoadLinks", {
  args: { request: Schema.String },
  messages: [Message.Loaded, Message.SessionExpired, Message.Failed],
  execute: ({ request }) =>
    readLinks.pipe(
      Effect.map((links) =>
        links === null
          ? Message.SessionExpired({ request })
          : Message.Loaded({ request, links }),
      ),
      Effect.catch(() =>
        Effect.succeed(
          Message.Failed({
            request,
            error: "Could not load links. Try again.",
          }),
        ),
      ),
    ),
});
const Save = Command.define("StoreLink", {
  args: { request: Schema.String, url: Schema.String },
  messages: [Message.Saved, Message.SessionExpired, Message.Failed],
  execute: ({ request, url }) =>
    saveLink(url).pipe(
      Effect.map((link) =>
        link === null
          ? Message.SessionExpired({ request })
          : Message.Saved({ request, link }),
      ),
      Effect.catch(() =>
        Effect.succeed(
          Message.Failed({
            request,
            error: "Could not confirm the save. Reload to check your links.",
          }),
        ),
      ),
    ),
});
const Delete = Command.define("DeleteLink", {
  args: { request: Schema.String, id: Schema.String },
  messages: [Message.Deleted, Message.SessionExpired, Message.Failed],
  execute: ({ request, id }) =>
    deleteLink(id).pipe(
      Effect.map((deleted) =>
        deleted
          ? Message.Deleted({ request, id })
          : Message.SessionExpired({ request }),
      ),
      Effect.catch(() =>
        Effect.succeed(
          Message.Failed({
            request,
            error: "Could not delete the link. Try again.",
          }),
        ),
      ),
    ),
});
const FocusLinkInput = Mount.define("FocusLinkInput", {
  messages: [Message.FocusedLinkInput],
  execute: ({ element }) =>
    Effect.sync(() => {
      if (element instanceof HTMLInputElement)
        element.focus({ preventScroll: true });
      return Message.FocusedLinkInput();
    }),
});
const savedAtFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const load = (model: Model): Update.Return<Model, Message> => {
  if (model.request) return { model };
  const request = crypto.randomUUID();
  return {
    model: {
      ...model,
      request: { id: request, kind: "load", linkId: null },
      loadError: null,
    },
    commands: [Load({ request })],
  };
};
const notification = (
  key: string,
  variant: Notification["variant"],
  title: string,
) => OutMessage.Notify({ notification: { key, variant, title } });

const writingCreation = (model: Model) => model.request?.kind === "create";

const submit = (model: Model, kind: "create" | "save") => {
  const draft = kind === "create" ? model.creation : model;
  if (!draft || model.request) return { model };
  const link = parseLinkInput(draft.url);
  const validationError = link ? null : invalidUrl;
  const next =
    kind === "create" && model.creation
      ? {
          ...model,
          creation: { ...model.creation, validationError, saveError: null },
        }
      : { ...model, validationError };
  if (!link) return { model: next };
  const request = crypto.randomUUID();
  return {
    model: { ...next, request: { id: request, kind, linkId: null } },
    commands: [Save({ request, ...link })],
  };
};

const withSavedLink = (records: Model["records"], link: typeof Link.Type) =>
  records &&
  [link, ...records.filter((item) => item.id !== link.id)].sort(
    (a, b) => b.savedAt - a.savedAt || b.id.localeCompare(a.id),
  );

export const update = (
  model: Model,
  message: Message,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> => {
  // No late completion (including an old 401) can affect a subsequent request/session.
  if ("request" in message && message.request !== model.request?.id)
    return { model };
  return Message.match<Update.ReturnWithOutMessage<Model, Message, OutMessage>>(
    message,
    {
      Requested: () => (model.records === null ? load(model) : { model }),
      Retried: () => load(model),
      EditedUrl: ({ url }) =>
        model.request
          ? { model }
          : { model: { ...model, url, validationError: null } },
      Submitted: () =>
        model.records === null ? { model } : submit(model, "save"),
      OpenedCreate: () => ({
        model:
          model.creation || writingCreation(model)
            ? model
            : {
                ...model,
                creation: { url: "", validationError: null, saveError: null },
              },
      }),
      EditedCreateUrl: ({ url }) => ({
        model:
          !model.creation || writingCreation(model)
            ? model
            : {
                ...model,
                creation: { ...model.creation, url, validationError: null },
              },
      }),
      SubmittedCreate: () => submit(model, "create"),
      ClosedCreate: () => ({
        model: writingCreation(model) ? model : { ...model, creation: null },
      }),
      RequestedDeletion: ({ id }) => {
        if (model.request || !model.records?.some((link) => link.id === id))
          return { model };
        const request = crypto.randomUUID();
        return {
          model: {
            ...model,
            request: { id: request, kind: "delete", linkId: id },
          },
          commands: [Delete({ request, id })],
        };
      },
      Loaded: ({ links }) =>
        model.request?.kind === "load"
          ? {
              model: {
                ...model,
                records: links,
                request: null,
                loadError: null,
              },
            }
          : { model },
      Saved: ({ link }) => {
        const kind = model.request?.kind;
        if (kind !== "save" && kind !== "create") return { model };
        const next = {
          ...model,
          records: withSavedLink(model.records, link),
          request: null,
        };
        return kind === "create"
          ? {
              model: { ...next, creation: null },
              outMessage: OutMessage.Created(),
            }
          : {
              model: { ...next, url: "" },
              outMessage: OutMessage.DismissNotification({ key: "links-save" }),
            };
      },
      Deleted: ({ id }) =>
        model.request?.kind === "delete" && model.request.linkId === id
          ? {
              model: {
                ...model,
                records:
                  model.records?.filter((link) => link.id !== id) ?? null,
                request: null,
              },
              outMessage: OutMessage.DismissNotification({
                key: "links-delete",
              }),
            }
          : { model },
      Failed: ({ error }) => {
        const kind = model.request?.kind;
        const next = { ...model, request: null };
        if (kind === "load") return { model: { ...next, loadError: error } };
        if (kind === "create" && model.creation)
          return {
            model: {
              ...next,
              creation: { ...model.creation, saveError: error },
            },
          };
        return {
          model: next,
          outMessage: notification(
            kind === "delete" ? "links-delete" : "links-save",
            "Error",
            error,
          ),
        };
      },
      SessionExpired: () => ({
        model: initial,
        outMessage: OutMessage.SessionExpired(),
      }),
      FocusedLinkInput: () => ({ model }),
      CompletedLinkAvatarImageMount: () => ({ model }),
    },
  );
};

export const createView = Submodel.defineView<
  Model,
  Message,
  { initialFocus: ReadonlyArray<ChildAttribute>; disabled: boolean }
>((model, { initialFocus, disabled }, h) => {
  const draft = model.creation;
  if (!draft) return h.empty;
  const saving = writingCreation(model);
  return h.form(
    [h.Class("link-create-form"), h.OnSubmit(Message.SubmittedCreate())],
    [
      field(
        "Link URL",
        input(
          [
            ...initialFocus,
            h.Id(creationUrlId),
            h.Type("text"),
            h.InputMode("url"),
            h.Autocapitalize("off"),
            h.Spellcheck(false),
            h.AriaInvalid(draft.validationError !== null),
            ...(draft.validationError
              ? [h.AriaDescribedBy(creationErrorId)]
              : []),
            h.Placeholder("Paste a URL"),
            h.EnterKeyHint("done"),
            h.Required(true),
            h.Value(draft.url),
            h.Readonly(disabled || saving),
            h.OnInput((url) => Message.EditedCreateUrl({ url })),
          ],
          h,
        ),
        h,
      ),
      ...(draft.validationError
        ? [
            h.p(
              [h.Id(creationErrorId), h.Role("alert")],
              [draft.validationError],
            ),
          ]
        : []),
      alert(
        { message: draft.saveError, severity: "error", announcement: "alert" },
        h,
      ),
      Dialog.footer(
        [
          button(
            {
              variant: "outline",
              disabled: saving,
              onClick: Message.ClosedCreate(),
              children: ["Cancel"],
            },
            h,
          ),
          button(
            {
              type: "submit",
              focusableWhenDisabled: saving,
              disabled: disabled || model.request !== null || !draft.url.trim(),
              children: [saving ? "Saving…" : "Save link"],
            },
            h,
          ),
        ],
        h,
      ),
    ],
  );
});

const savedLinkAvatar = (url: string, h: HtmlBuilder<Message>) => {
  const hostname = websiteIconHostname(url);
  return avatar(
    {
      variant: "square",
      src: hostname ? websiteIconPath(hostname) : null,
      imageMounted: Message.CompletedLinkAvatarImageMount(),
      fallback: h.svg(
        [
          h.ViewBox("0 0 24 24"),
          h.Width("18"),
          h.Height("18"),
          h.Fill("none"),
          h.Stroke("currentColor"),
          h.StrokeWidth("1.75"),
          h.StrokeLinecap("round"),
        ],
        [
          h.path([h.D("M10 13a4 4 0 0 0 6 .4l4-4a4 4 0 0 0-5.7-5.7L12 6")], []),
          h.path(
            [h.D("M14 11a4 4 0 0 0-6-.4l-4 4a4 4 0 0 0 5.7 5.7L12 18")],
            [],
          ),
        ],
      ),
    },
    h,
  );
};

type ViewInputs = { disabled: boolean; creationDialogId: string };

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, { disabled, creationDialogId }, h) =>
    h.section(
      [h.Class("links")],
      [
        screenHeader(
          {
            title: "Links",
            primaryAction: button(
              {
                size: "sm",
                ariaLabel: "Save link",
                dialogId: creationDialogId,
                disabled:
                  disabled ||
                  (model.request !== null && !writingCreation(model)),
                onClick: Message.OpenedCreate(),
                children: [plusIcon(h, "16"), "Link"],
              },
              h,
            ),
          },
          h,
        ),
        ...(model.loadError ? [h.p([h.Role("alert")], [model.loadError])] : []),
        ...(model.records === null
          ? [
              disabled || model.request !== null
                ? h.p([h.Role("status")], ["Loading links…"])
                : h.button(
                    [h.Type("button"), h.OnClick(Message.Retried())],
                    ["Retry"],
                  ),
            ]
          : [
              h.form(
                [h.Method("post"), h.OnSubmit(Message.Submitted())],
                [
                  buttonGroup(
                    [
                      input(
                        [
                          h.Id("link-url"),
                          h.Type("text"),
                          h.InputMode("url"),
                          h.Autocapitalize("off"),
                          h.Spellcheck(false),
                          h.AriaLabel("Link URL"),
                          h.AriaInvalid(model.validationError !== null),
                          ...(model.validationError
                            ? [h.AriaDescribedBy("link-url-error")]
                            : []),
                          h.Placeholder("Paste a URL"),
                          h.EnterKeyHint("done"),
                          h.Required(true),
                          h.Value(model.url),
                          h.Readonly(disabled || model.request !== null),
                          h.OnMount(FocusLinkInput()),
                          h.OnInput((url) => Message.EditedUrl({ url })),
                        ],
                        h,
                      ),
                      button(
                        {
                          type: "submit",
                          variant: "outline",
                          size: "icon",
                          ariaLabel: "Save link",
                          disabled:
                            disabled ||
                            model.request !== null ||
                            !parseLinkInput(model.url),
                          children: [plusIcon(h, "18")],
                        },
                        h,
                      ),
                    ],
                    h,
                  ),
                  ...(model.validationError
                    ? [
                        h.p(
                          [h.Id("link-url-error"), h.Role("alert")],
                          [model.validationError],
                        ),
                      ]
                    : []),
                  h.p(
                    [h.Role("status")],
                    [
                      model.request?.kind === "delete"
                        ? "Deleting link…"
                        : disabled || model.request !== null
                          ? "Saving…"
                          : "",
                    ],
                  ),
                ],
              ),
              model.records.length === 0
                ? h.p([], ["No saved links yet."])
                : itemGroup(
                    model.records.map((link) =>
                      item(
                        {
                          key: link.id,
                          href: link.url,
                          target: "_blank",
                          media: savedLinkAvatar(link.url, h),
                          title: link.url.replace(/^https?:\/\//i, ""),
                          description: h.time(
                            [h.Datetime(new Date(link.savedAt).toISOString())],
                            [savedAtFormat.format(link.savedAt)],
                          ),
                          action: button(
                            {
                              variant: "ghost",
                              size: "icon",
                              ariaLabel: `Delete ${link.url}`,
                              disabled: disabled || model.request !== null,
                              onClick: Message.RequestedDeletion({
                                id: link.id,
                              }),
                              children: [outlineIcon(h, trashIconPaths)],
                            },
                            h,
                          ),
                        },
                        h,
                      ),
                    ),
                    h,
                  ),
            ]),
      ],
    ),
);
