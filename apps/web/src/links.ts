import { Link, LinkList } from "@oneapp/core/links";
import {
  avatar,
  button,
  buttonGroup,
  item,
  itemGroup,
  outlineIcon,
  plusIcon,
  trashIconPaths,
} from "@oneapp/ui";
import { Effect, Schema } from "effect";
import { Command, Mount, Submodel, type Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import {
  deleteLink,
  parseLinkInput,
  readLinks,
  saveLink,
} from "./links-client.ts";
import { Notification } from "./notifications.ts";
import { websiteIconHostname, websiteIconPath } from "./website-icon-host.ts";

export const Model = Schema.Struct({
  records: Schema.NullOr(LinkList),
  url: Schema.String,
  request: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.Literals(["load", "save", "delete"]),
      linkId: Schema.NullOr(Schema.String),
    }),
  ),
  validationError: Schema.NullOr(Schema.String),
  loadError: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;
export const initial: Model = {
  records: null,
  url: "",
  request: null,
  validationError: null,
  loadError: null,
};
export const Message = defineMessageUnion({
  Requested: {},
  Retried: {},
  EditedUrl: { url: Schema.String },
  Submitted: {},
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
      Submitted: () => {
        if (model.request || model.records === null) return { model };
        const input = parseLinkInput(model.url);
        if (!input)
          return {
            model: {
              ...model,
              validationError:
                "Enter a valid HTTP or HTTPS URL without credentials.",
            },
          };
        const request = crypto.randomUUID();
        return {
          model: {
            ...model,
            request: { id: request, kind: "save", linkId: null },
            validationError: null,
          },
          commands: [Save({ request, ...input })],
        };
      },
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
      Saved: ({ link }) =>
        model.request?.kind === "save"
          ? {
              model: {
                ...model,
                records: [
                  link,
                  ...(model.records ?? []).filter(
                    (item) => item.id !== link.id,
                  ),
                ].sort(
                  (a, b) => b.savedAt - a.savedAt || b.id.localeCompare(a.id),
                ),
                url: "",
                request: null,
              },
              outMessage: OutMessage.DismissNotification({ key: "links-save" }),
            }
          : { model },
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
      Failed: ({ error }) =>
        model.request?.kind === "load"
          ? { model: { ...model, request: null, loadError: error } }
          : {
              model: { ...model, request: null },
              outMessage: notification(
                model.request?.kind === "save" ? "links-save" : "links-delete",
                "Error",
                error,
              ),
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

const savedLinkAvatar = (url: string, h: HtmlBuilder<Message>) => {
  const hostname = websiteIconHostname(url);
  return avatar(
    {
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

export const view = Submodel.defineView<Model, Message, { disabled: boolean }>(
  (model, { disabled }, h) =>
    h.section(
      [h.Class("links")],
      [
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
                      h.input([
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
                      ]),
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
                              rounded: true,
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
