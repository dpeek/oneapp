import {
  alert,
  button,
  Dialog,
  field,
  input,
  item,
  itemGroup,
  spinner,
  visuallyHiddenStatus,
} from "@oneapp/ui";
import { Effect, Option, Schema } from "effect";
import { Command, Submodel, Update } from "foldkit";
import { focus } from "foldkit/dom";
import type { Attribute, ChildAttribute, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import {
  ItemId,
  normalizeTagName,
  Tag,
  tagApi,
  TagName,
  tagNameKey,
  tagNameLimit,
  tagsApi,
} from "./items-contract.ts";

const Tags = Schema.Array(Tag);
const Operation = Schema.Union([
  Schema.TaggedStruct("Load", {}),
  Schema.TaggedStruct("Create", { name: TagName }),
  Schema.TaggedStruct("Rename", { id: ItemId, name: TagName }),
  Schema.TaggedStruct("Delete", { id: ItemId }),
]);
type Operation = typeof Operation.Type;
const DialogAction = Schema.Union([
  Schema.TaggedStruct("Rename", { tag: Tag, name: Schema.String }),
  Schema.TaggedStruct("Delete", { tag: Tag }),
]);
const createNameId = "settings-tag-name";

export const Model = Schema.Struct({
  tags: Schema.NullOr(Tags),
  name: Schema.String,
  dialog: Dialog.Model,
  action: Schema.NullOr(DialogAction),
  request: Schema.NullOr(Schema.Struct({ id: ItemId, operation: Operation })),
  error: Schema.NullOr(Schema.String),
  status: Schema.String,
});
type Model = typeof Model.Type;

export const initial: Model = {
  tags: null,
  name: "",
  dialog: Dialog.init({ id: "settings-tag-dialog" }),
  action: null,
  request: null,
  error: null,
  status: "",
};

export const Message = defineMessageUnion({
  Requested: {},
  ChangedName: { name: Schema.String },
  SubmittedCreate: {},
  OpenedAction: { id: ItemId, kind: Schema.Literals(["Rename", "Delete"]) },
  ChangedRename: { name: Schema.String },
  SubmittedAction: {},
  GotDialogMessage: { message: Dialog.Message },
  Loaded: { request: ItemId, tags: Tags },
  Saved: { request: ItemId, tag: Tag },
  Deleted: { request: ItemId },
  Failed: { request: ItemId, error: Schema.String },
  SessionExpired: { request: ItemId },
  Focused: {},
});
type Message = typeof Message.Type;
const OutMessage = defineMessageUnion({ SessionExpired: {} });
type OutMessage = typeof OutMessage.Type;
type Result = Update.ReturnWithOutMessage<Model, Message, OutMessage>;

const toDialogMessage = (message: typeof Dialog.Message.Type) =>
  Message.GotDialogMessage({ message });
const foldDialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.dialog),
  write: (model, dialog) => ({ ...model, dialog }),
  toParentMessage: toDialogMessage,
  foldOutMessage: () => (model) => ({ model }),
});

const FocusCreate = Command.define("FocusCreateTagName", {
  messages: [Message.Focused],
  execute: focus(`#${createNameId}`, { preventScroll: true }).pipe(
    Effect.ignore,
    Effect.as(Message.Focused()),
  ),
});

const Request = Command.define("RequestTagSettings", {
  args: { request: ItemId, operation: Operation },
  messages: [
    Message.Loaded,
    Message.Saved,
    Message.Deleted,
    Message.Failed,
    Message.SessionExpired,
  ],
  execute: ({ request, operation }) => {
    const failed = Message.Failed({
      request,
      error: "Could not save the tag. Try again.",
    });
    return Effect.tryPromise(async (signal) => {
      const response = await fetch(
        "id" in operation ? tagApi(operation.id) : tagsApi,
        {
          signal,
          cache: "no-store",
          method: {
            Load: "GET",
            Create: "POST",
            Rename: "PUT",
            Delete: "DELETE",
          }[operation._tag],
          ...(operation._tag === "Load"
            ? {}
            : {
                headers: {
                  "x-effect-auth-csrf": "1",
                  ...("name" in operation
                    ? { "content-type": "application/json" }
                    : {}),
                },
              }),
          ...("name" in operation
            ? { body: JSON.stringify({ name: operation.name }) }
            : {}),
        },
      );
      if (response.status === 401) return Message.SessionExpired({ request });
      if (
        operation._tag === "Delete" &&
        (response.ok || response.status === 404)
      )
        return Message.Deleted({ request });
      if (operation._tag === "Rename" && response.status === 409)
        return Message.Failed({
          request,
          error: "A tag with this name already exists.",
        });
      if (operation._tag === "Rename" && response.status === 404)
        return Message.Failed({
          request,
          error: "This tag was deleted. Reopen Tags to refresh the list.",
        });
      if (!response.ok) throw new Error("Tag request failed");
      const body: unknown = await response.json();
      return operation._tag === "Load"
        ? Message.Loaded({
            request,
            tags: Schema.decodeUnknownSync(Tags)(body),
          })
        : Message.Saved({ request, tag: Schema.decodeUnknownSync(Tag)(body) });
    }).pipe(
      Effect.orElseSucceed(() => {
        switch (operation._tag) {
          case "Load":
            return Message.Failed({
              request,
              error: "Could not load tags. Try again.",
            });
          case "Delete":
            return Message.Failed({
              request,
              error: "Could not delete the tag. Try again.",
            });
          default:
            return failed;
        }
      }),
    );
  },
});

const start = (model: Model, operation: Operation): Result => {
  if (model.request) return { model };
  const id = crypto.randomUUID();
  return {
    model: { ...model, request: { id, operation }, error: null, status: "" },
    commands: [Request({ request: id, operation })],
  };
};

const save = (model: Model, inputName: string, id?: string): Result => {
  const name = normalizeTagName(inputName);
  if (!Schema.is(TagName)(name))
    return {
      model: {
        ...model,
        error: name
          ? `Use ${tagNameLimit} characters or fewer.`
          : "Enter a tag name.",
      },
    };
  if (
    model.tags?.some(
      (tag) => tag.id !== id && tagNameKey(tag.name) === tagNameKey(name),
    )
  )
    return {
      model: { ...model, error: "A tag with this name already exists." },
    };
  return start(
    model,
    id ? { _tag: "Rename", id, name } : { _tag: "Create", name },
  );
};

export const update = (
  model: Model,
  message: Message,
  visible: boolean,
): Result => {
  if ("request" in message && message.request !== model.request?.id)
    return { model };
  return Message.match<Result>(message, {
    Requested: () =>
      model.request
        ? { model }
        : start({ ...model, tags: null }, { _tag: "Load" }),
    ChangedName: ({ name }) => ({
      model: { ...model, name, error: null, status: "" },
    }),
    SubmittedCreate: () =>
      model.request || model.dialog.isOpen || !model.tags
        ? { model }
        : save(model, model.name),
    OpenedAction: ({ id, kind }) => {
      const tag = model.tags?.find((tag) => tag.id === id);
      if (!tag || model.request || model.action) return { model };
      const action =
        kind === "Rename"
          ? ({ _tag: kind, tag, name: tag.name } as const)
          : ({ _tag: kind, tag } as const);
      return foldDialog(
        { ...model, action, error: null, status: "" },
        Dialog.Message.RequestedOpen(),
      );
    },
    ChangedRename: ({ name }) => ({
      model:
        model.action?._tag === "Rename"
          ? { ...model, action: { ...model.action, name }, error: null }
          : model,
    }),
    SubmittedAction: () => {
      const { action } = model;
      if (!model.dialog.isOpen || !action || model.request) return { model };
      return action._tag === "Rename"
        ? save(model, action.name, action.tag.id)
        : start(model, { _tag: "Delete", id: action.tag.id });
    },
    GotDialogMessage: ({ message }) => {
      if (message._tag === "RequestedClose" && model.request) return { model };
      if (message._tag === "CompletedCloseDialog") {
        const removed =
          model.action?._tag === "Delete" &&
          !model.tags?.some(({ id }) => id === model.action?.tag.id);
        return {
          model: { ...model, action: null, error: null },
          ...(removed && visible ? { commands: [FocusCreate()] } : {}),
        };
      }
      if (
        message._tag === "Unmounted" ||
        message._tag === "FailedShowDialog" ||
        message._tag === "FailedAcquireResources"
      )
        return foldDialog({ ...model, action: null }, message);
      return foldDialog(model, message);
    },
    Loaded: ({ tags }) => ({ model: { ...model, tags, request: null } }),
    Saved: ({ tag }) => {
      const renamed = model.request?.operation._tag === "Rename";
      const next = {
        ...model,
        tags: [
          ...(model.tags ?? []).filter(({ id }) => id !== tag.id),
          tag,
        ].sort((a, b) => tagNameKey(a.name).localeCompare(tagNameKey(b.name))),
        request: null,
        name: renamed ? model.name : "",
        status: renamed ? `Tag renamed to ${tag.name}.` : `${tag.name} added.`,
      };
      return renamed && next.dialog.isOpen
        ? foldDialog(next, Dialog.Message.RequestedClose())
        : { model: next };
    },
    Deleted: () => {
      const operation = model.request?.operation;
      if (operation?._tag !== "Delete") return { model };
      const next = {
        ...model,
        tags: (model.tags ?? []).filter(({ id }) => id !== operation.id),
        request: null,
        status: "Tag deleted.",
      };
      return next.dialog.isOpen
        ? foldDialog(next, Dialog.Message.RequestedClose())
        : { model: next };
    },
    Failed: ({ error }) => ({
      model: { ...model, request: null, error },
    }),
    SessionExpired: () => ({ model, outMessage: OutMessage.SessionExpired() }),
    Focused: () => ({ model }),
  });
};

const tagNameField = (
  name: string,
  readonly: boolean,
  attributes: ReadonlyArray<Attribute<Message> | ChildAttribute>,
  changed: (name: string) => Message,
  h: HtmlBuilder<Message>,
) =>
  field(
    "Tag name",
    input(
      [
        ...attributes,
        h.Value(name),
        h.Readonly(readonly),
        h.Autocomplete("off"),
        h.OnInput(changed),
      ],
      h,
    ),
    h,
  );

const actionDialog = (model: Model, h: HtmlBuilder<Message>) => {
  const action = model.action;
  const deleting = action?._tag === "Delete";
  const pending = model.request !== null;
  return Dialog.view(
    {
      model: model.dialog,
      title: deleting ? "Delete tag?" : "Rename tag",
      ...(deleting
        ? {
            alertDescription: `“${action.tag.name}” will be removed from all tasks and files.`,
          }
        : {}),
      toParentMessage: toDialogMessage,
      content: (initialFocus) =>
        h.form(
          [h.Class("settings-section"), h.OnSubmit(Message.SubmittedAction())],
          [
            ...(deleting
              ? []
              : [
                  tagNameField(
                    action?.name ?? "",
                    pending,
                    initialFocus,
                    (name) => Message.ChangedRename({ name }),
                    h,
                  ),
                ]),
            alert(
              {
                message: model.error,
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
                    attributes: deleting ? initialFocus : [],
                    onClick: toDialogMessage(Dialog.Message.RequestedClose()),
                    children: ["Cancel"],
                  },
                  h,
                ),
                button(
                  {
                    type: "submit",
                    variant: deleting ? "destructive" : "primary",
                    disabled: pending,
                    focusableWhenDisabled: true,
                    children: [
                      deleting
                        ? pending
                          ? "Deleting…"
                          : "Delete tag"
                        : pending
                          ? "Saving…"
                          : "Save name",
                    ],
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

const tagList = (model: Model, h: HtmlBuilder<Message>) => {
  if (model.tags === null)
    return model.request
      ? h.div([h.Class("settings-loading")], [spinner("Loading tags…", h)])
      : h.empty;
  if (!model.tags.length)
    return h.p([h.Class("account-hint")], ["No tags yet."]);
  return itemGroup(
    model.tags.map(({ id, name }) =>
      item(
        {
          key: id,
          title: name,
          action: h.div(
            [h.Class("settings-tag-actions")],
            (["Rename", "Delete"] as const).map((kind) =>
              button(
                {
                  size: "sm",
                  variant: "ghost",
                  disabled: model.request !== null,
                  focusableWhenDisabled: true,
                  ariaLabel: `${kind} ${name}`,
                  dialogId: model.dialog.id,
                  onClick: Message.OpenedAction({ id, kind }),
                  children: [kind],
                },
                h,
              ),
            ),
          ),
        },
        h,
      ),
    ),
    h,
  );
};

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const unavailable = model.request !== null || model.tags === null;
  const creating = model.request?.operation._tag === "Create";
  return h.section(
    [h.Class("settings-section"), h.AriaLabel("Manage tags")],
    [
      h.form(
        [h.Class("settings-tag-form"), h.OnSubmit(Message.SubmittedCreate())],
        [
          tagNameField(
            model.name,
            unavailable,
            [h.Id(createNameId)],
            (name) => Message.ChangedName({ name }),
            h,
          ),
          button(
            {
              type: "submit",
              disabled: unavailable,
              focusableWhenDisabled: creating,
              children: [creating ? "Adding…" : "Add tag"],
            },
            h,
          ),
        ],
      ),
      alert(
        {
          message: model.action ? null : model.error,
          severity: "error",
          announcement: "alert",
          action:
            model.tags === null && model.error
              ? button(
                  {
                    size: "sm",
                    variant: "outline",
                    onClick: Message.Requested(),
                    children: ["Retry loading tags"],
                  },
                  h,
                )
              : undefined,
        },
        h,
      ),
      visuallyHiddenStatus(model.status, h),
      tagList(model, h),
      actionDialog(model, h),
    ],
  );
});
