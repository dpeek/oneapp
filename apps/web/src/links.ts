import { Link, LinkList } from "@orumai/core/links";
import {
  alert,
  avatar,
  button,
  Dialog,
  field,
  input,
  item,
  ItemActionMenu,
  itemGroup,
  outlineIcon,
  trashIconPaths,
} from "@orumai/ui";
import { Effect, Option, Schema } from "effect";
import { Command, Dom, Render, Submodel, Update } from "foldkit";
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
const actionsId = "saved-link-actions";
const invalidUrl = "Enter a valid HTTP or HTTPS URL without credentials.";
const actions = [
  {
    action: "open",
    label: "Open",
    icon: (h: HtmlBuilder<Message>) =>
      outlineIcon(h, [
        "M13 5h6v6m0-6-9 9m7-1v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5",
      ]),
  },
  {
    action: "copy",
    label: "Copy URL",
    icon: (h: HtmlBuilder<Message>) =>
      outlineIcon(h, ["M9 9h10v10H9zM15 9V5H5v10h4"]),
  },
  {
    action: "delete",
    label: "Delete",
    icon: (h: HtmlBuilder<Message>) => outlineIcon(h, trashIconPaths),
    destructive: true,
  },
] as const;
const actionMenu = ItemActionMenu.create<(typeof actions)[number]["action"]>();
export const Model = Schema.Struct({
  records: Schema.NullOr(LinkList),
  actions: ItemActionMenu.Model,
  creation: Schema.NullOr(
    Schema.Struct({
      url: Schema.String,
      validationError: Schema.NullOr(Schema.String),
      saveError: Schema.NullOr(Schema.String),
    }),
  ),
  request: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.Literals(["load", "create", "delete"]),
      linkId: Schema.NullOr(Schema.String),
    }),
  ),
  loadError: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;
export const initial: Model = {
  records: null,
  actions: ItemActionMenu.init(actionsId),
  creation: null,
  request: null,
  loadError: null,
};
export const Message = defineMessageUnion({
  Requested: {},
  Retried: {},
  OpenedCreate: {},
  EditedCreateUrl: { url: Schema.String },
  SubmittedCreate: {},
  ClosedCreate: {},
  RequestedDeletion: { id: Schema.String },
  GotActionMenu: { message: ItemActionMenu.Message },
  UnmountedLinks: {},
  OpenedSavedLink: {},
  CopiedUrl: { copied: Schema.Boolean },
  RecoveredDeletedLinkFocus: {},
  Loaded: { request: Schema.String, links: LinkList },
  Saved: { request: Schema.String, link: Link },
  Deleted: { request: Schema.String, id: Schema.String },
  Failed: { request: Schema.String, error: Schema.String },
  SessionExpired: { request: Schema.String },
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
const OpenSavedLink = Command.define("OpenSavedLink", {
  args: { id: Schema.String },
  messages: [Message.OpenedSavedLink],
  execute: ({ id }) =>
    Dom.clickElement(
      `#${CSS.escape(ItemActionMenu.rowLinkId(actionsId, id))}`,
    ).pipe(Effect.ignore, Effect.as(Message.OpenedSavedLink())),
});
const CopyUrl = Command.define("CopySavedLinkUrl", {
  args: { url: Schema.String },
  messages: [Message.CopiedUrl],
  execute: ({ url }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(url)).pipe(
      Effect.match({
        onSuccess: () => Message.CopiedUrl({ copied: true }),
        onFailure: () => Message.CopiedUrl({ copied: false }),
      }),
    ),
});
const RecoverDeletedLinkFocus = Command.define("RecoverDeletedLinkFocus", {
  args: { neighborId: Schema.NullOr(Schema.String) },
  messages: [Message.RecoveredDeletedLinkFocus],
  execute: ({ neighborId }) =>
    Render.afterCommit.pipe(
      Effect.andThen(
        Effect.sync(() => {
          // A pending delete may finish after the user has moved focus elsewhere.
          if (document.activeElement === document.body) {
            if (neighborId === null) {
              document
                .querySelector<HTMLElement>(".links .workspace-header")
                ?.focus();
            } else {
              const trigger = document.getElementById(
                ItemActionMenu.triggerId(actionsId, neighborId),
              );
              const target = trigger?.getClientRects().length
                ? trigger
                : document.getElementById(
                    ItemActionMenu.rowLinkId(actionsId, neighborId),
                  );
              target?.focus();
            }
          }
          return Message.RecoveredDeletedLinkFocus();
        }),
      ),
    ),
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

const submitCreation = (model: Model): Update.Return<Model, Message> => {
  if (!model.creation || model.request) return { model };
  const link = parseLinkInput(model.creation.url);
  const next = {
    ...model,
    creation: {
      ...model.creation,
      validationError: link ? null : invalidUrl,
      saveError: null,
    },
  };
  if (!link) return { model: next };
  const request = crypto.randomUUID();
  return {
    model: { ...next, request: { id: request, kind: "create", linkId: null } },
    commands: [Save({ request, ...link })],
  };
};

const withSavedLink = (records: Model["records"], link: typeof Link.Type) =>
  records &&
  [link, ...records.filter((item) => item.id !== link.id)].sort(
    (a, b) => b.savedAt - a.savedAt || b.id.localeCompare(a.id),
  );

const toActionMenuMessage = (message: typeof ItemActionMenu.Message.Type) =>
  Message.GotActionMenu({ message });

const requestDeletion = (
  model: Model,
  id: string,
): Update.Return<Model, Message> => {
  if (model.request || !model.records?.some((link) => link.id === id))
    return { model };
  const request = crypto.randomUUID();
  return {
    model: { ...model, request: { id: request, kind: "delete", linkId: id } },
    commands: [Delete({ request, id })],
  };
};

const updateActionMenu = Update.foldChild({
  update: actionMenu.update,
  read: (model: Model) => Option.some(model.actions),
  write: (model, actions) => ({ ...model, actions }),
  toParentMessage: toActionMenuMessage,
  foldOutMessage:
    ({ key, action }): Update.Step<Model, Message> =>
    (model) => {
      const link = model.records?.find(({ id }) => id === key);
      if (!link) return { model };
      if (action === "open")
        return { model, commands: [OpenSavedLink({ id: key })] };
      if (action === "copy")
        return { model, commands: [CopyUrl({ url: link.url })] };
      return requestDeletion(model, key);
    },
});

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
      SubmittedCreate: () => submitCreation(model),
      ClosedCreate: () => ({
        model: writingCreation(model) ? model : { ...model, creation: null },
      }),
      RequestedDeletion: ({ id }) => requestDeletion(model, id),
      GotActionMenu: ({ message }) => updateActionMenu(model, message),
      UnmountedLinks: () => ({ model: { ...model, actions: initial.actions } }),
      OpenedSavedLink: () => ({ model }),
      CopiedUrl: ({ copied }) => ({
        model,
        outMessage: copied
          ? OutMessage.Notify({
              notification: {
                key: "links-copy",
                variant: "Success",
                title: "Copied URL.",
                durationMs: 3000,
              },
            })
          : notification(
              "links-copy",
              "Error",
              "Could not copy the URL. Try again.",
            ),
      }),
      RecoveredDeletedLinkFocus: () => ({ model }),
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
        writingCreation(model)
          ? {
              model: {
                ...model,
                records: withSavedLink(model.records, link),
                creation: null,
                request: null,
              },
              outMessage: OutMessage.Created(),
            }
          : { model },
      Deleted: ({ id }) => {
        if (model.request?.kind !== "delete" || model.request.linkId !== id)
          return { model };
        const index = model.records?.findIndex((link) => link.id === id) ?? -1;
        const neighbor =
          model.records?.[index + 1] ?? model.records?.[index - 1];
        return {
          model: {
            ...model,
            records: model.records?.filter((link) => link.id !== id) ?? null,
            request: null,
            actions:
              model.actions.row?.key === id ? initial.actions : model.actions,
          },
          commands:
            index < 0
              ? []
              : [
                  RecoverDeletedLinkFocus({
                    neighborId: neighbor?.id ?? null,
                  }),
                ],
          outMessage: OutMessage.DismissNotification({ key: "links-delete" }),
        };
      },
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
        return kind === "delete"
          ? {
              model: next,
              outMessage: notification("links-delete", "Error", error),
            }
          : { model: next };
      },
      SessionExpired: () => ({
        model: initial,
        outMessage: OutMessage.SessionExpired(),
      }),
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

const savedLinkRow = (
  link: typeof Link.Type,
  model: Model,
  deleteDisabled: boolean,
  h: HtmlBuilder<Message>,
) => {
  const items = actions.map(({ icon, ...action }) => ({
    ...action,
    icon: icon(h),
    disabled: action.action === "delete" && deleteDisabled,
  }));
  return item(
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
      attributes: ItemActionMenu.rowAttributes(link.id, toActionMenuMessage, h),
      linkAttributes: ItemActionMenu.rowLinkAttributes(
        actionsId,
        link.id,
        items,
        toActionMenuMessage,
        h,
      ),
      action: actionMenu.view(
        {
          model: model.actions,
          rowKey: link.id,
          label: `Actions for ${link.url}`,
          items,
          toParentMessage: toActionMenuMessage,
        },
        h,
      ),
    },
    h,
  );
};

type ViewInputs = { disabled: boolean };

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, { disabled }, h) =>
    h.section(
      [h.Class("links"), h.OnUnmount(Message.UnmountedLinks())],
      [
        screenHeader(
          {
            title: "Links",
            feedback: [
              h.p(
                [h.Class("workspace-header-progress"), h.Role("status")],
                [model.request?.kind === "delete" ? "Deleting link…" : ""],
              ),
            ],
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
              model.records.length === 0
                ? h.p([], ["No saved links yet."])
                : itemGroup(
                    model.records.map((link) =>
                      savedLinkRow(
                        link,
                        model,
                        disabled || model.request !== null,
                        h,
                      ),
                    ),
                    h,
                  ),
            ]),
      ],
    ),
);
