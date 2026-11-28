import { Dialog, ItemActionMenu, MultiCombobox, Popover } from "@orumai/ui";
import { Effect, Option, Schema } from "effect";
import { Command, Dom, Update } from "foldkit";
import { focus } from "foldkit/dom";
import { defineMessageUnion } from "foldkit/message";
import {
  fileApi,
  fileContentApi,
  fileDocumentApi,
  fileDocumentsApi,
  fileImageApi,
  DocumentMarkdown,
  DocumentTitle,
  FileDocument,
  FileDocumentCreate,
  FileDocumentUpdate,
  FileDeletion,
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
import * as Edits from "./file-document-edits.ts";
import { imageUploadLimit, invalidImage } from "./image-upload.ts";
import { InlineImagePaste } from "./markdown-editor-contract.ts";
import { clearTagChoice, createTagPrefix, tagChoices } from "./tag-picker.ts";
import { checkIndex } from "./workspace-changes.ts";

export const uploadInputId = "files-upload";
export const createUploadInputId = "create-file-upload";
export const fileDeleteDialogId = "file-delete-dialog";
export const creationTitleId = "file-create-title";
export const fileActionsId = "file-actions";
export const fileActionMenu = ItemActionMenu.create<"open" | "download">();
const closedActions = ItemActionMenu.init(fileActionsId);
const UploadSource = Schema.Literals(["header", "create"]);
const Creation = Schema.Struct({
  id: ItemId,
  source: UploadSource,
  title: Schema.String,
  markdown: Schema.String,
  tagIds: ItemTagIds,
  error: Schema.NullOr(Schema.String),
});
const TagPicker = Schema.Struct({
  popover: Popover.Model,
  search: MultiCombobox.Model,
});
export const tagPickerId = (id: string) => `file-tags-${id}`;

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
  Schema.TaggedStruct("CreateDocument", {
    source: UploadSource,
    input: FileDocumentCreate,
  }),
  Schema.TaggedStruct("AddDraftTag", { id: ItemId, name: TagName }),
  Schema.TaggedStruct("ReadDocument", { id: ItemId }),
  Schema.TaggedStruct("SaveDocument", {
    id: ItemId,
    input: FileDocumentUpdate,
  }),
  Schema.TaggedStruct("Delete", { id: ItemId, input: FileDeletion }),
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
  actions: ItemActionMenu.Model,
  filterPopover: Popover.Model,
  tagOptionsOpen: Schema.Boolean,
  tagPicker: Schema.NullOr(TagPicker),
  creation: Schema.NullOr(Creation),
  previewFailed: Schema.Boolean,
  documents: Schema.Record(ItemId, Edits.Draft),
  documentLoadFailed: Schema.NullOr(ItemId),
  deleteDialog: Dialog.Model,
  deletion: Schema.NullOr(
    Schema.Struct({
      id: ItemId,
      revision: ItemId,
      name: Schema.String,
      completed: Schema.Boolean,
      error: Schema.NullOr(Schema.String),
    }),
  ),
  request: Schema.NullOr(Schema.Struct({ id: ItemId, operation: Operation })),
  refreshRequest: Schema.NullOr(ItemId),
  refreshPending: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;
export const initial: Model = {
  index: null,
  selectedId: null,
  tagFilter: null,
  actions: closedActions,
  ...closedFilterMenu,
  tagPicker: null,
  creation: null,
  previewFailed: false,
  documents: {},
  documentLoadFailed: null,
  deleteDialog: Dialog.init({ id: fileDeleteDialogId }),
  deletion: null,
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
  GotActionMenu: { message: ItemActionMenu.Message },
  Unmounted: {},
  ActivatedFileAction: {},
  PickedFile: { source: UploadSource, selected: Schema.Boolean },
  GotFilterPopoverMessage: { message: Popover.Message },
  OpenedTagFilterOptions: { focusOptions: Schema.Boolean },
  ClosedTagFilterOptions: {},
  SelectedTagFilter: { value: Schema.NullOr(ItemId) },
  ClearedTagFilter: {},
  GotTagPopoverMessage: { id: ItemId, message: Popover.Message },
  GotTagSearchMessage: { id: ItemId, message: MultiCombobox.Message },
  PreviewReady: { id: ItemId },
  PreviewFailed: { id: ItemId },
  OpenedCreate: { source: UploadSource },
  ClosedCreate: {},
  DismissedCreate: {},
  EditedCreation: { field: Edits.Field, value: Schema.String },
  CreatedDocument: {},
  DraftTagAdded: { request: ItemId, tag: Tag },
  DocumentLoaded: { request: ItemId, document: FileDocument },
  DocumentSaved: {
    request: ItemId,
    document: FileDocument,
    conflict: Schema.Boolean,
  },
  EditedDocument: { id: ItemId, field: Edits.Field, value: Schema.String },
  BlurredDocument: { id: ItemId },
  DocumentDebounced: { id: ItemId, timer: ItemId },
  RetriedDocument: { id: ItemId },
  DiscardedDocumentEdits: { id: ItemId },
  PickedDocumentImage: { documentId: ItemId, ...InlineImagePaste.fields },
  FinishedDocumentImage: {
    documentId: ItemId,
    id: ItemId,
    outcome: Schema.Union([Schema.Literal(true), Schema.String]),
    expired: Schema.Boolean,
  },
  RequestedDelete: {},
  ConfirmedDelete: {},
  GotDeleteDialogMessage: { message: Dialog.Message },
  Deleted: { request: ItemId, id: ItemId },
  DeleteConflict: { request: ItemId, file: StoredFile },
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
  OpenList: {},
  UploadFailed: { error: Schema.String },
  SessionExpired: {},
});
export type OutMessage = typeof OutMessage.Type;

const OpenFileRow = Command.define("OpenFileRow", {
  args: { id: ItemId },
  messages: [Message.ActivatedFileAction],
  execute: ({ id }) =>
    Dom.clickElement(
      `#${CSS.escape(ItemActionMenu.rowLinkId(fileActionsId, id))}`,
    ).pipe(Effect.ignore, Effect.as(Message.ActivatedFileAction())),
});

const DownloadFileRow = Command.define("DownloadFileRow", {
  args: { id: ItemId, name: FileName },
  messages: [Message.ActivatedFileAction],
  execute: ({ id, name }) =>
    Effect.sync(() => {
      const link = document.createElement("a");
      link.href = fileContentApi(id, "download");
      link.download = name;
      link.click();
      return Message.ActivatedFileAction();
    }),
});

const writeJson = (
  method: "POST" | "PUT" | "DELETE",
  value: unknown,
): RequestInit => ({
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
const failureMessages = {
  Load: "Could not load files. Try again.",
  Upload: "Could not upload the file. Try again.",
  Tags: "Could not save the file tags. Try again.",
  CreateDocument: "Could not create the document. Try again.",
  AddDraftTag: "Could not create the tag. Try again.",
  ReadDocument: "Could not load the document. Try again.",
  SaveDocument: "Could not save the document. Your edits are still here.",
  Delete: "Could not delete the file. Try again.",
};

const Request = Command.define("RequestFiles", {
  args: { request: ItemId, operation: Operation },
  messages: [
    Message.Loaded,
    Message.DocumentLoaded,
    Message.DraftTagAdded,
    Message.DocumentSaved,
    Message.Deleted,
    Message.DeleteConflict,
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
        case "CreateDocument":
        case "ReadDocument": {
          const response =
            operation._tag === "CreateDocument"
              ? await send(fileDocumentsApi, writeJson("POST", operation.input))
              : await send(fileDocumentApi(operation.id));
          if (response.status === 401) return expired;
          if (!response.ok) return failed(failureMessages[operation._tag]);
          return Message.DocumentLoaded({
            request,
            document: Schema.decodeUnknownSync(FileDocument)(
              await response.json(),
            ),
          });
        }
        case "AddDraftTag": {
          const response = await send(
            tagsApi,
            writeJson("POST", { name: operation.name }),
          );
          if (response.status === 401) return expired;
          if (!response.ok) return failed(failureMessages.AddDraftTag);
          return Message.DraftTagAdded({
            request,
            tag: Schema.decodeUnknownSync(Tag)(await response.json()),
          });
        }
        case "SaveDocument": {
          const response = await send(
            fileDocumentApi(operation.id),
            writeJson("PUT", operation.input),
          );
          if (response.status === 401) return expired;
          if (response.status === 404)
            return failed(
              "This document is unavailable. Your edits are still here.",
            );
          if (response.status === 422)
            return failed(
              "An image is unavailable. Remove it and insert it again, then retry the save.",
            );
          const conflict = response.status === 409;
          if (!response.ok && !conflict)
            return failed(failureMessages.SaveDocument);
          return Message.DocumentSaved({
            request,
            conflict,
            document: Schema.decodeUnknownSync(FileDocument)(
              await response.json(),
            ),
          });
        }
        case "Delete": {
          const response = await send(
            fileApi(operation.id),
            writeJson("DELETE", operation.input),
          );
          if (response.status === 401) return expired;
          if (response.status === 409)
            return Message.DeleteConflict({
              request,
              file: Schema.decodeUnknownSync(StoredFile)(await response.json()),
            });
          if (!response.ok && response.status !== 404)
            return failed(failureMessages.Delete);
          return Message.Deleted({ request, id: operation.id });
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
            error: failureMessages[operation._tag],
          }),
        ),
      ),
    ),
});

const DebounceDocument = Command.define("DebounceFileDocument", {
  args: { id: ItemId, timer: ItemId },
  messages: [Message.DocumentDebounced],
  execute: (args) =>
    Effect.sleep(500).pipe(Effect.as(Message.DocumentDebounced(args))),
});

const UploadDocumentImage = Command.define("UploadFileDocumentImage", {
  args: { documentId: ItemId, ...InlineImagePaste.fields },
  messages: [Message.FinishedDocumentImage],
  execute: ({ documentId, id, file }) => {
    const finish = (outcome: true | string, expired = false) =>
      Message.FinishedDocumentImage({ documentId, id, outcome, expired });
    const failure = "Could not upload the image. Try inserting it again.";
    if (file.size === 0 || file.size > imageUploadLimit)
      return Effect.succeed(finish(invalidImage));
    return Effect.tryPromise(async (signal) => {
      const response = await fetch(fileImageApi(documentId, id), {
        method: "POST",
        cache: "no-store",
        signal,
        headers: { "x-effect-auth-csrf": "1" },
        body: file,
      });
      if (response.ok) return finish(true);
      if (response.status === 413 || response.status === 415)
        return finish(invalidImage);
      return finish(failure, response.status === 401);
    }).pipe(Effect.orElseSucceed(() => finish(failure)));
  },
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

export const matchesFileFilter = (
  file: StoredFile,
  tagFilter: Model["tagFilter"],
) => tagFilter === null || file.tagIds.includes(tagFilter);

export const toActionMenuMessage = (message: ItemActionMenu.Message) =>
  Message.GotActionMenu({ message });

const foldActionMenu = Update.foldChild({
  update: fileActionMenu.update,
  read: (model: Model) => Option.some(model.actions),
  write: (model, actions) => ({ ...model, actions }),
  toParentMessage: toActionMenuMessage,
  foldOutMessage:
    ({ key, action }): Update.Step<Model, Message> =>
    (model) => {
      const file = model.index?.files.find(({ id }) => id === key);
      if (
        !file ||
        !matchesFileFilter(file, model.tagFilter) ||
        (file.authored && action === "download")
      )
        return { model };
      return {
        model,
        commands: [
          action === "open"
            ? OpenFileRow({ id: file.id })
            : DownloadFileRow({ id: file.id, name: file.name }),
        ],
      };
    },
});

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

export const writingCreation = (model: Model) =>
  model.request?.operation._tag === "CreateDocument" ||
  model.request?.operation._tag === "AddDraftTag";

const tagTarget = (model: Model, id: string) =>
  model.creation
    ? model.creation.id === id
      ? model.creation
      : null
    : model.selectedId === id
      ? selectedFile(model)
      : null;

const updateTagPopover = (
  model: Model,
  id: string,
  message: typeof Popover.Message.Type,
): Update.Return<Model, Message> => {
  if (!tagTarget(model, id) || !model.index) return { model };
  const key = tagPickerId(id);
  const picker = model.tagPicker?.popover.id === key ? model.tagPicker : null;
  const previous = picker?.popover ?? Popover.init({ id: key });
  const result = Popover.update(previous, message);
  if (!picker && !result.model.isOpen) return { model };
  return {
    model: {
      ...model,
      tagPicker: {
        popover: result.model,
        search:
          previous.isOpen && picker
            ? picker.search
            : MultiCombobox.init(`${key}-search`),
      },
    },
    commands: Command.mapMessages(result.commands ?? [], (message) =>
      Message.GotTagPopoverMessage({ id, message }),
    ),
  };
};

const toggleTags = (tagIds: readonly string[], value: string) =>
  value === clearTagChoice
    ? []
    : tagIds.includes(value)
      ? tagIds.filter((id) => id !== value)
      : [...tagIds, value];

const updateTagSearch = (
  model: Model,
  id: string,
  message: typeof MultiCombobox.Message.Type,
): Update.Return<Model, Message> => {
  const picker = model.tagPicker;
  const target = tagTarget(model, id);
  if (
    !target ||
    !picker?.popover.isOpen ||
    picker.popover.id !== tagPickerId(id)
  )
    return { model };
  const result = MultiCombobox.update(picker.search, message);
  const next = { ...model, tagPicker: { ...picker, search: result.model } };
  const selection = result.outMessage;
  if (selection?._tag !== "Selected")
    return {
      model: next,
      commands: Command.mapMessages(result.commands ?? [], (message) =>
        Message.GotTagSearchMessage({ id, message }),
      ),
    };
  if (model.request) return { model: next };
  const { value } = selection;
  const { tagIds } = target;
  const { choices } = tagChoices(
    picker.search.inputValue,
    tagIds,
    model.index?.tags ?? [],
  );
  if (
    value !== clearTagChoice &&
    !choices.some((choice) => choice.id === value && !choice.disabled)
  )
    return { model: next };
  const name = value.startsWith(createTagPrefix)
    ? value.slice(createTagPrefix.length)
    : null;
  const reset = {
    ...next,
    tagPicker: {
      ...picker,
      search: {
        ...result.model,
        inputValue: name ? "" : picker.search.inputValue,
        maybeActiveItemIndex: Option.none(),
      },
    },
  };
  if (model.creation)
    return name
      ? start(reset, { _tag: "AddDraftTag", id, name })
      : {
          model: {
            ...reset,
            creation: {
              ...model.creation,
              tagIds: toggleTags(tagIds, value),
              error: null,
            },
          },
        };
  if (!("revision" in target)) return { model: next };
  return start(reset, {
    _tag: "Tags",
    id,
    revision: target.revision,
    tagIds: name ? tagIds : toggleTags(tagIds, value),
    ...(name ? { newTagName: name } : {}),
  });
};

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

export const toDeleteDialogMessage = (message: typeof Dialog.Message.Type) =>
  Message.GotDeleteDialogMessage({ message });

const foldDeleteDialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.deleteDialog),
  write: (model, deleteDialog) => ({ ...model, deleteDialog }),
  toParentMessage: toDeleteDialogMessage,
  foldOutMessage: () => (model) => ({ model }),
});

const withDocument = (model: Model, id: string, draft: Edits.Draft): Model => ({
  ...model,
  documents: { ...model.documents, [id]: draft },
});

const replaceFile = (model: Model, file: StoredFile): Model => ({
  ...model,
  index: model.index && {
    ...model.index,
    files: model.index.files.some(({ id }) => id === file.id)
      ? model.index.files.map((entry) => (entry.id === file.id ? file : entry))
      : [file, ...model.index.files],
  },
});

const withTag = (model: Model, tag: Tag | null): Model =>
  tag && model.index && !model.index.tags.some(({ id }) => id === tag.id)
    ? { ...model, index: { ...model.index, tags: [...model.index.tags, tag] } }
    : model;

const applyIndex = (model: Model, index: typeof FileIndex.Type): Model => ({
  ...model,
  index,
  creation: model.creation && {
    ...model.creation,
    tagIds: model.creation.tagIds.filter((tagId) =>
      index.tags.some(({ id }) => id === tagId),
    ),
  },
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
            ? { ...model, ...closedFilterMenu, actions: closedActions }
            : model;
        const next =
          id === current.selectedId
            ? current
            : {
                ...current,
                selectedId: id,
                tagPicker: null,
                previewFailed: false,
                documentLoadFailed: null,
              };
        return refresh || !next.index
          ? start(next, { _tag: "Load" })
          : { model: next };
      },
      Retried: () => {
        if (model.documentLoadFailed)
          return { model: { ...model, documentLoadFailed: null } };
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
      GotActionMenu: ({ message }) => foldActionMenu(model, message),
      Unmounted: () => ({ model: { ...model, actions: closedActions } }),
      ActivatedFileAction: () => ({ model }),
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
      GotTagPopoverMessage: ({ id, message }) =>
        updateTagPopover(model, id, message),
      GotTagSearchMessage: ({ id, message }) =>
        updateTagSearch(model, id, message),
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
      OpenedCreate: ({ source }) => {
        if (
          model.creation ||
          model.deletion ||
          (source === "header" && (!model.index || model.request))
        )
          return { model };
        const next = {
          ...model,
          tagPicker: null,
          refreshPending:
            model.refreshPending ||
            (source === "create" && model.index !== null),
          creation: {
            id: crypto.randomUUID(),
            source,
            title: "",
            markdown: "",
            tagIds: [],
            error: null,
          },
        };
        return model.index ? { model: next } : start(next, { _tag: "Load" });
      },
      ClosedCreate: () => ({
        model:
          model.creation && !writingCreation(model)
            ? { ...model, creation: null, tagPicker: null }
            : model,
      }),
      DismissedCreate: () =>
        model.creation && model.tagPicker?.popover.isOpen
          ? updateTagPopover(
              model,
              model.creation.id,
              Popover.Message.RequestedClose(),
            )
          : transition(model, Message.ClosedCreate()),
      EditedCreation: ({ field, value }) => ({
        model:
          model.creation && model.request?.operation._tag !== "CreateDocument"
            ? {
                ...model,
                creation: { ...model.creation, [field]: value, error: null },
              }
            : model,
      }),
      CreatedDocument: () => {
        const { creation, index, request } = model;
        if (!creation || !index || request) return { model };
        const { id, source, tagIds, markdown } = creation;
        const title = creation.title.trim();
        if (
          !Schema.is(DocumentTitle)(title) ||
          !Schema.is(DocumentMarkdown)(markdown)
        )
          return { model };
        return start(
          { ...model, creation: { ...creation, error: null }, tagPicker: null },
          {
            _tag: "CreateDocument",
            source,
            input: { id, title, markdown, tagIds },
          },
        );
      },
      DraftTagAdded: ({ tag }) => {
        const { creation } = model;
        const operation = model.request?.operation;
        const next = withTag({ ...model, request: null }, tag);
        if (
          !creation ||
          operation?._tag !== "AddDraftTag" ||
          operation.id !== creation.id
        )
          return { model: next };
        return {
          model: {
            ...next,
            creation: {
              ...creation,
              tagIds: creation.tagIds.includes(tag.id)
                ? creation.tagIds
                : [...creation.tagIds, tag.id],
              error: null,
            },
          },
        };
      },
      DocumentLoaded: ({ document }) => {
        const operation = model.request?.operation;
        const { file } = document;
        const draft = model.documents[file.id];
        const next = withDocument(
          replaceFile({ ...model, request: null }, file),
          file.id,
          draft && (Edits.changed(draft) || Edits.uploading(draft))
            ? draft
            : Edits.init(document),
        );
        return operation?._tag === "CreateDocument"
          ? {
              model: {
                ...next,
                creation: null,
                tagPicker: null,
                tagFilter: null,
              },
              outMessage: OutMessage.OpenFile({
                id: file.id,
                source: operation.source,
              }),
            }
          : { model: next };
      },
      EditedDocument: ({ id, field, value }) => {
        const draft = model.documents[id];
        if (!draft || draft[field] === value) return { model };
        const timer = crypto.randomUUID();
        return {
          model: withDocument(model, id, {
            ...draft,
            [field]: value,
            timer,
            queued: false,
          }),
          commands: [DebounceDocument({ id, timer })],
        };
      },
      BlurredDocument: ({ id }) => {
        const draft = model.documents[id];
        return draft && Edits.changed(draft)
          ? {
              model: withDocument(model, id, {
                ...draft,
                timer: null,
                queued: true,
              }),
            }
          : { model };
      },
      DocumentDebounced: ({ id, timer }) => {
        const draft = model.documents[id];
        return draft?.timer === timer
          ? {
              model: withDocument(model, id, {
                ...draft,
                timer: null,
                queued: true,
              }),
            }
          : { model };
      },
      DocumentSaved: ({ document, conflict }) => {
        const { file } = document;
        const draft = model.documents[file.id];
        const next = replaceFile({ ...model, request: null }, file);
        return {
          model: !draft
            ? next
            : withDocument(
                next,
                file.id,
                conflict
                  ? { ...draft, latest: document }
                  : Edits.acceptSave(draft, document),
              ),
        };
      },
      RetriedDocument: ({ id }) => {
        const draft = model.documents[id];
        return draft
          ? { model: withDocument(model, id, Edits.retry(draft)) }
          : { model };
      },
      DiscardedDocumentEdits: ({ id }) => {
        const latest = model.documents[id]?.latest;
        return latest
          ? { model: withDocument(model, id, Edits.init(latest)) }
          : { model };
      },
      PickedDocumentImage: ({ documentId, id, file }) => {
        const draft = model.documents[documentId];
        if (!draft) return { model };
        return {
          model: withDocument(model, documentId, {
            ...draft,
            uploads: { ...draft.uploads, [id]: file },
          }),
          commands: [UploadDocumentImage({ documentId, id, file })],
        };
      },
      FinishedDocumentImage: ({ documentId, id, outcome, expired }) => {
        const draft = model.documents[documentId];
        return {
          model:
            draft && draft.uploads[id] instanceof File
              ? withDocument(model, documentId, {
                  ...draft,
                  uploads: { ...draft.uploads, [id]: outcome },
                })
              : model,
          ...(expired ? { outMessage: OutMessage.SessionExpired() } : {}),
        };
      },
      RequestedDelete: () => {
        const file = selectedFile(model);
        if (!file || model.request || model.deletion) return { model };
        const { id, revision, name } = file;
        return foldDeleteDialog(
          {
            ...model,
            deletion: { id, revision, name, completed: false, error: null },
          },
          Dialog.Message.RequestedOpen(),
        );
      },
      ConfirmedDelete: () => {
        const { deletion } = model;
        if (
          !deletion ||
          model.request ||
          selectedFile(model)?.revision !== deletion.revision
        )
          return { model };
        return start(
          { ...model, deletion: { ...deletion, error: null } },
          {
            _tag: "Delete",
            id: deletion.id,
            input: { revision: deletion.revision },
          },
        );
      },
      GotDeleteDialogMessage: ({ message }) => {
        if (
          message._tag === "RequestedClose" &&
          model.request?.operation._tag === "Delete"
        )
          return { model };
        const result = foldDeleteDialog(model, message);
        if (message._tag === "Unmounted" || message._tag === "FailedShowDialog")
          return { ...result, model: { ...result.model, deletion: null } };
        if (
          message._tag !== "CompletedCloseDialog" ||
          result.model.deleteDialog.isOpen
        )
          return result;
        return {
          ...result,
          model: { ...result.model, deletion: null },
          ...(model.deletion?.completed &&
          model.deletion.id === model.selectedId
            ? { outMessage: OutMessage.OpenList() }
            : {}),
        };
      },
      Deleted: ({ id }) => {
        const documents = { ...model.documents };
        delete documents[id];
        const next = {
          ...model,
          documents,
          index: model.index && {
            ...model.index,
            files: model.index.files.filter((file) => file.id !== id),
          },
          request: null,
          refreshPending: true,
        };
        return model.deletion?.id === id && model.deleteDialog.isOpen
          ? foldDeleteDialog(
              { ...next, deletion: { ...model.deletion, completed: true } },
              Dialog.Message.RequestedClose(),
            )
          : {
              model: next,
              ...(id === model.selectedId
                ? { outMessage: OutMessage.OpenList() }
                : {}),
            };
      },
      DeleteConflict: ({ file }) => ({
        model: replaceFile(
          { ...model, request: null, refreshPending: true },
          file,
        ),
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
      SavedTags: ({ file, tag, conflict }) => {
        const operation = model.request?.operation;
        const draft = model.documents[file.id];
        const next = replaceFile(
          withTag(
            {
              ...model,
              request: null,
              error: conflict
                ? "This file’s tags changed elsewhere. Try again."
                : null,
            },
            tag,
          ),
          file,
        );
        return {
          model:
            !conflict && draft && operation?._tag === "Tags"
              ? withDocument(
                  next,
                  file.id,
                  Edits.acceptTags(draft, operation.revision, file),
                )
              : next,
        };
      },
      Failed: ({ error }) => {
        const operation = model.request?.operation;
        const next = { ...model, request: null };
        if (
          model.creation &&
          (operation?._tag === "CreateDocument" ||
            operation?._tag === "AddDraftTag")
        )
          return { model: { ...next, creation: { ...model.creation, error } } };
        if (operation?._tag === "SaveDocument") {
          const draft = model.documents[operation.id];
          if (draft)
            return {
              model: withDocument(next, operation.id, { ...draft, error }),
            };
        }
        if (operation?._tag === "Delete" && model.deletion)
          return { model: { ...next, deletion: { ...model.deletion, error } } };
        return {
          model: {
            ...next,
            error,
            ...(operation?._tag === "ReadDocument"
              ? { documentLoadFailed: operation.id }
              : {}),
          },
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
  const transitionResult = transition(model, message);
  const { actions, index, tagFilter } = transitionResult.model;
  const key = actions.row?.key;
  const result =
    key &&
    !index?.files.some(
      (file) => file.id === key && matchesFileFilter(file, tagFilter),
    )
      ? {
          ...transitionResult,
          model: { ...transitionResult.model, actions: closedActions },
        }
      : transitionResult;
  const next = result.model;
  if (!next.request && !next.deletion && !result.outMessage) {
    const file = selectedFile(next);
    if (file?.authored && next.documentLoadFailed !== file.id) {
      const draft = next.documents[file.id];
      if (
        !draft ||
        (!Edits.changed(draft) &&
          !Edits.uploading(draft) &&
          !draft.error &&
          !draft.latest &&
          !draft.timer &&
          draft.saved.file.revision !== file.revision)
      ) {
        const read = start(next, { _tag: "ReadDocument", id: file.id });
        return {
          ...read,
          commands: [...(result.commands ?? []), ...(read.commands ?? [])],
        };
      }
    }
    for (const [id, draft] of Object.entries(next.documents)) {
      if (
        !draft.queued ||
        draft.error ||
        draft.latest ||
        Edits.uploading(draft) ||
        !Edits.changed(draft) ||
        !Schema.is(DocumentTitle)(draft.title.trim()) ||
        !Schema.is(DocumentMarkdown)(draft.markdown)
      )
        continue;
      const save = start(withDocument(next, id, { ...draft, queued: false }), {
        _tag: "SaveDocument",
        id,
        input: {
          revision: draft.saved.file.revision,
          title: draft.title.trim(),
          markdown: draft.markdown,
        },
      });
      return {
        ...save,
        commands: [...(result.commands ?? []), ...(save.commands ?? [])],
      };
    }
  }
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
