import { Popover, Tokenizer } from "@orumai/ui";
import { Effect, Option, Schema } from "effect";
import { Command, Update } from "foldkit";
import { focus } from "foldkit/dom";
import { defineMessageUnion } from "foldkit/message";
import {
  fileApi,
  FileIndex,
  FileName,
  fileNameHeader,
  filesApi,
  fileUploadLimit,
  StoredFile,
} from "./files-contract.ts";
import {
  ItemId,
  ItemTagIds,
  itemTagLimit,
  Tag,
  TagName,
  tagsApi,
} from "./items-contract.ts";
import { createTagPrefix, searchTags } from "./tag-picker.ts";
import { checkIndex } from "./workspace-changes.ts";

export const uploadInputId = "files-upload";
export const createUploadInputId = "create-file-upload";
const UploadSource = Schema.Literals(["header", "create"]);

export const openUploadPicker = () => {
  const input = document.getElementById(createUploadInputId);
  if (!(input instanceof HTMLInputElement) || input.disabled) return;
  if (typeof input.showPicker === "function") input.showPicker();
  else input.click();
};

export const filterOptionsId = "file-filter-options";
const closedFilterMenu = {
  filterPopover: Popover.init({ id: "file-filters" }),
  tagOptionsOpen: false,
};
const Operation = Schema.Union([
  Schema.TaggedStruct("Load", {}),
  Schema.TaggedStruct("Upload", { source: UploadSource }),
  Schema.TaggedStruct("Tags", {
    id: ItemId,
    revision: ItemId,
    tagIds: ItemTagIds,
    newTagName: Schema.optionalKey(TagName),
  }),
]);
type Operation = typeof Operation.Type;
export const Model = Schema.Struct({
  index: Schema.NullOr(FileIndex),
  selectedId: Schema.NullOr(ItemId),
  tagFilter: Schema.NullOr(ItemId),
  filterPopover: Popover.Model,
  tagOptionsOpen: Schema.Boolean,
  tagPicker: Tokenizer.Model,
  previewFailed: Schema.Boolean,
  request: Schema.NullOr(Schema.Struct({ id: ItemId, operation: Operation })),
  refreshRequest: Schema.NullOr(ItemId),
  refreshPending: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;
const tagPicker = () => Tokenizer.init({ id: "file-tags" });
export const initial: Model = {
  index: null,
  selectedId: null,
  tagFilter: null,
  ...closedFilterMenu,
  tagPicker: tagPicker(),
  previewFailed: false,
  request: null,
  refreshRequest: null,
  refreshPending: false,
  error: null,
};
export const Message = defineMessageUnion({
  Opened: { id: Schema.NullOr(ItemId), refresh: Schema.Boolean },
  Retried: {},
  RefreshRequested: {},
  RefreshCompleted: {
    check: ItemId,
    result: Schema.Union([
      FileIndex,
      Schema.Literals(["unchanged", "expired"]),
    ]),
  },
  FocusUpdated: {},
  PickedFile: { source: UploadSource, selected: Schema.Boolean },
  GotFilterPopoverMessage: { message: Popover.Message },
  OpenedTagFilterOptions: { focusOptions: Schema.Boolean },
  ClosedTagFilterOptions: {},
  SelectedTagFilter: { value: Schema.NullOr(ItemId) },
  ClearedTagFilter: {},
  GotTagPickerMessage: { id: ItemId, message: Tokenizer.Message },
  RemovedTag: { id: ItemId },
  PreviewReady: { id: ItemId },
  PreviewFailed: { id: ItemId },
  Loaded: { request: ItemId, index: FileIndex },
  Uploaded: { request: ItemId, file: StoredFile },
  SavedTags: {
    request: ItemId,
    file: StoredFile,
    tag: Schema.NullOr(Tag),
    conflict: Schema.Boolean,
  },
  Failed: { request: ItemId, error: Schema.String },
  SessionExpired: { request: ItemId },
});
export type Message = typeof Message.Type;
export const OutMessage = defineMessageUnion({
  OpenFile: { id: ItemId, source: UploadSource },
  UploadFailed: { error: Schema.String },
  SessionExpired: {},
});
export type OutMessage = typeof OutMessage.Type;

const writeJson = (method: "POST" | "PUT", value: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json", "x-effect-auth-csrf": "1" },
  body: JSON.stringify(value),
});
const FocusRetryTarget = Command.define("FocusFileRetryTarget", {
  messages: [Message.FocusUpdated],
  execute: focus(".files-workspace > .workspace-header", {
    preventScroll: true,
  }).pipe(Effect.ignore, Effect.as(Message.FocusUpdated())),
});
const FocusTagFilter = Command.define("FocusFileTagFilter", {
  args: { target: Schema.Literals(["options", "button"]) },
  messages: [Message.FocusUpdated],
  execute: ({ target }) =>
    focus(
      target === "options"
        ? `#${filterOptionsId} input:checked`
        : `#${Popover.buttonId(closedFilterMenu.filterPopover.id)}`,
      { preventScroll: target === "button" },
    ).pipe(Effect.ignore, Effect.as(Message.FocusUpdated())),
});
const Request = Command.define("RequestFiles", {
  args: { request: ItemId, operation: Operation },
  messages: [
    Message.Loaded,
    Message.Uploaded,
    Message.SavedTags,
    Message.Failed,
    Message.SessionExpired,
  ],
  execute: ({ request, operation }) =>
    Effect.tryPromise(async (signal) => {
      const send = (path: string, init?: RequestInit) =>
        fetch(path, { ...init, signal, cache: "no-store" });
      const expired = Message.SessionExpired({ request });
      const failed = (error: string) => Message.Failed({ request, error });
      switch (operation._tag) {
        case "Load": {
          const response = await send(filesApi);
          if (response.status === 401) return expired;
          if (!response.ok) return failed("Could not load files. Try again.");
          const index = Schema.decodeUnknownSync(FileIndex)(
            await response.json(),
          );
          return Message.Loaded({ request, index });
        }
        case "Upload": {
          const input = document.getElementById(
            operation.source === "create" ? createUploadInputId : uploadInputId,
          );
          const file =
            input instanceof HTMLInputElement ? input.files?.[0] : undefined;
          if (input instanceof HTMLInputElement) input.value = "";
          if (!file) return failed("Choose a file to upload.");
          if (file.size > fileUploadLimit)
            return failed("Choose a file up to 16 MiB.");
          if (!Schema.is(FileName)(file.name))
            return failed("The filename is invalid.");
          const response = await send(filesApi, {
            method: "POST",
            headers: {
              "content-type": file.type || "application/octet-stream",
              [fileNameHeader]: encodeURIComponent(file.name),
              "x-effect-auth-csrf": "1",
            },
            body: file,
          });
          if (response.status === 401) return expired;
          if (!response.ok)
            return failed("Could not upload the file. Try again.");
          return Message.Uploaded({
            request,
            file: Schema.decodeUnknownSync(StoredFile)(await response.json()),
          });
        }
        case "Tags": {
          let tag: Tag | null = null;
          if (operation.newTagName) {
            const response = await send(
              tagsApi,
              writeJson("POST", { name: operation.newTagName }),
            );
            if (response.status === 401) return expired;
            if (!response.ok)
              return failed("Could not create the tag. Try again.");
            tag = Schema.decodeUnknownSync(Tag)(await response.json());
          }
          const tagIds = tag
            ? [...new Set([...operation.tagIds, tag.id])]
            : operation.tagIds;
          const response = await send(
            fileApi(operation.id),
            writeJson("PUT", {
              revision: operation.revision,
              tagIds,
            }),
          );
          if (response.status === 401) return expired;
          const conflict = response.status === 409;
          if (!response.ok && !conflict)
            return failed("Could not save the file tags. Try again.");
          return Message.SavedTags({
            request,
            tag,
            conflict,
            file: Schema.decodeUnknownSync(StoredFile)(await response.json()),
          });
        }
      }
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          Message.Failed({
            request,
            error: {
              Load: "Could not load files. Try again.",
              Upload: "Could not upload the file. Try again.",
              Tags: "Could not save the file tags. Try again.",
            }[operation._tag],
          }),
        ),
      ),
    ),
});

const CheckVersion = Command.define("CheckFileVersion", {
  args: { check: ItemId, version: FileIndex.fields.version },
  messages: [Message.RefreshCompleted],
  execute: ({ check, version }) =>
    Effect.tryPromise((signal) =>
      checkIndex(filesApi, version, FileIndex, signal),
    ).pipe(
      Effect.map((result) => Message.RefreshCompleted({ check, result })),
      Effect.orElseSucceed(() =>
        Message.RefreshCompleted({ check, result: "unchanged" }),
      ),
    ),
});

export const selectedFile = (model: Model) =>
  model.index?.files.find(({ id }) => id === model.selectedId) ?? null;

const start = (model: Model, operation: Operation) => {
  if (model.request) return { model };
  const id = crypto.randomUUID();
  return {
    model: {
      ...model,
      request: { id, operation },
      // Discard a snapshot taken before this operation and check again afterward.
      refreshRequest: null,
      refreshPending: model.refreshPending || model.refreshRequest !== null,
      error: null,
    },
    commands: [Request({ request: id, operation })],
  };
};

const toTagPickerMessage =
  (id: string) => (message: typeof Tokenizer.Message.Type) =>
    Message.GotTagPickerMessage({ id, message });

export const toFilterPopoverMessage = (message: typeof Popover.Message.Type) =>
  Message.GotFilterPopoverMessage({ message });

const foldFilterPopover = Update.foldChild({
  update: Popover.update,
  read: (model: Model) => Option.some(model.filterPopover),
  write: (model, filterPopover) => ({ ...model, filterPopover }),
  toParentMessage: toFilterPopoverMessage,
  foldOutMessage: (out) => (model) => ({
    model: out._tag === "Closed" ? { ...model, tagOptionsOpen: false } : model,
  }),
});

const applyIndex = (model: Model, index: typeof FileIndex.Type): Model => ({
  ...model,
  index,
  tagFilter: index.tags.some(({ id }) => id === model.tagFilter)
    ? model.tagFilter
    : null,
});

const transition = (
  model: Model,
  message: Message,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> => {
  if ("request" in message && message.request !== model.request?.id)
    return { model };
  return Message.match<Update.ReturnWithOutMessage<Model, Message, OutMessage>>(
    message,
    {
      Opened: ({ id, refresh }) => {
        const current =
          refresh || id !== model.selectedId
            ? { ...model, ...closedFilterMenu }
            : model;
        const next =
          id === current.selectedId
            ? current
            : {
                ...current,
                selectedId: id,
                tagPicker: tagPicker(),
                previewFailed: false,
              };
        return refresh || !next.index
          ? start(next, { _tag: "Load" })
          : { model: next };
      },
      Retried: () => {
        const result = start(model, { _tag: "Load" });
        return result.commands
          ? { ...result, commands: [FocusRetryTarget(), ...result.commands] }
          : result;
      },
      RefreshRequested: () => ({
        model:
          model.index || model.request?.operation._tag === "Load"
            ? { ...model, refreshPending: true }
            : model,
      }),
      RefreshCompleted: ({ check, result }) => {
        if (check !== model.refreshRequest) return { model };
        const next = { ...model, refreshRequest: null };
        if (result === "expired")
          return { model: next, outMessage: OutMessage.SessionExpired() };
        return {
          model: result === "unchanged" ? next : applyIndex(next, result),
        };
      },
      FocusUpdated: () => ({ model }),
      PickedFile: ({ source, selected }) =>
        selected ? start(model, { _tag: "Upload", source }) : { model },
      GotFilterPopoverMessage: ({ message }) =>
        foldFilterPopover(model, message),
      OpenedTagFilterOptions: ({ focusOptions }) => {
        if (!model.filterPopover.isOpen) return { model };
        return {
          model: { ...model, tagOptionsOpen: true },
          ...(focusOptions
            ? { commands: [FocusTagFilter({ target: "options" })] }
            : {}),
        };
      },
      ClosedTagFilterOptions: () => ({
        model: { ...model, tagOptionsOpen: false },
      }),
      SelectedTagFilter: ({ value }) => ({
        model: { ...model, tagFilter: value },
      }),
      ClearedTagFilter: () => {
        const cleared = { ...model, tagFilter: null };
        return model.filterPopover.isOpen
          ? foldFilterPopover(cleared, Popover.Message.RequestedClose())
          : {
              model: cleared,
              commands: [FocusTagFilter({ target: "button" })],
            };
      },
      GotTagPickerMessage: ({ id, message }) => {
        const file = selectedFile(model);
        if (!file || id !== file.id) return { model };
        const result = Tokenizer.update(model.tagPicker, message);
        const next = { ...model, tagPicker: result.model };
        const commands = Command.mapMessages(
          result.commands ?? [],
          toTagPickerMessage(id),
        );
        const selection = result.outMessage;
        if (
          model.request ||
          file.tagIds.length >= itemTagLimit ||
          selection?._tag !== "Selected"
        )
          return { model: next, commands };
        const tags = model.index?.tags ?? [];
        const reset = {
          ...next,
          tagPicker: {
            ...next.tagPicker,
            inputValue: "",
            maybeActiveItemIndex: Option.none(),
          },
        };
        const operation = {
          _tag: "Tags",
          id,
          revision: file.revision,
        } as const;
        const { value } = selection;
        if (value.startsWith(createTagPrefix)) {
          const { name, canCreate } = searchTags(
            result.model.inputValue,
            file.tagIds,
            tags,
          );
          if (canCreate && value === `${createTagPrefix}${name}`)
            return start(reset, {
              ...operation,
              tagIds: file.tagIds,
              newTagName: name,
            });
        }
        if (
          tags.some((tag) => tag.id === value) &&
          !file.tagIds.includes(value)
        )
          return start(reset, {
            ...operation,
            tagIds: [...file.tagIds, value],
          });
        return { model: next, commands };
      },
      RemovedTag: ({ id }) => {
        const file = selectedFile(model);
        if (!file?.tagIds.includes(id)) return { model };
        return start(model, {
          _tag: "Tags",
          id: file.id,
          revision: file.revision,
          tagIds: file.tagIds.filter((tag) => tag !== id),
        });
      },
      PreviewReady: ({ id }) => ({
        model:
          id === model.selectedId ? { ...model, previewFailed: false } : model,
      }),
      PreviewFailed: ({ id }) => ({
        model:
          id === model.selectedId ? { ...model, previewFailed: true } : model,
      }),
      Loaded: ({ index }) => ({
        model: applyIndex({ ...model, request: null }, index),
      }),
      Uploaded: ({ file }) => {
        const operation = model.request?.operation;
        if (operation?._tag !== "Upload") return { model };
        return {
          model: {
            ...model,
            index: model.index && {
              ...model.index,
              files: [file, ...model.index.files],
            },
            request: null,
            tagFilter: null,
          },
          outMessage: OutMessage.OpenFile({
            id: file.id,
            source: operation.source,
          }),
        };
      },
      SavedTags: ({ file, tag, conflict }) => ({
        model: {
          ...model,
          index: model.index && {
            ...model.index,
            files: model.index.files.map((entry) =>
              entry.id === file.id ? file : entry,
            ),
            tags:
              tag && !model.index.tags.some(({ id }) => id === tag.id)
                ? [...model.index.tags, tag]
                : model.index.tags,
          },
          request: null,
          error: conflict
            ? "This file’s tags changed elsewhere. Try again."
            : null,
        },
      }),
      Failed: ({ error }) => {
        const operation = model.request?.operation;
        return {
          model: { ...model, request: null, error },
          ...(operation?._tag === "Upload" && operation.source === "create"
            ? { outMessage: OutMessage.UploadFailed({ error }) }
            : {}),
        };
      },
      SessionExpired: () => ({
        model,
        outMessage: OutMessage.SessionExpired(),
      }),
    },
  );
};

export const update = (model: Model, message: Message) => {
  const result = transition(model, message);
  const next = result.model;
  if (
    !next.refreshPending ||
    !next.index ||
    next.request ||
    next.refreshRequest ||
    result.outMessage?._tag === "SessionExpired"
  )
    return result;

  const check = crypto.randomUUID();
  return {
    ...result,
    model: { ...next, refreshRequest: check, refreshPending: false },
    commands: [
      ...(result.commands ?? []),
      CheckVersion({ check, version: next.index.version }),
    ],
  };
};
