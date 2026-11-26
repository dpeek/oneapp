import {
  CalendarPicker,
  Dialog,
  DropdownMenu,
  ItemActionMenu,
  MultiCombobox,
  Popover,
  Sheet,
  Tokenizer,
} from "@orumai/ui";
import { Temporal } from "@js-temporal/polyfill";
import { Effect, Option, Schema } from "effect";
import { Command, Render, Update } from "foldkit";
import { focus } from "foldkit/dom";
import { defineMessageUnion } from "foldkit/message";
import { ItemId, Tag, TagCreate, tagsApi } from "./items-contract.ts";
import { createTagPrefix, searchTags } from "./tag-picker.ts";
import { checkIndex } from "./workspace-changes.ts";
import * as Edits from "./task-edits.ts";
import {
  calendarChoice,
  clearChoice,
  dueChoices,
  initPicker,
  Picker,
  pickerId,
  PickerTarget,
  Property,
  tagChoices,
  taskCalendar,
} from "./task-properties.ts";
import * as Attachments from "./task-attachments.ts";
import {
  defaultTaskStatus,
  Task,
  taskApi,
  TaskAssignee,
  TaskCreate,
  TaskDate,
  TaskDelete,
  TaskPriority,
  TaskRoute,
  TaskSnapshot,
  TaskStatus,
  TaskUpdate,
  tasksApi,
  taskTagLimit,
} from "./tasks-contract.ts";
import {
  defaultFilters,
  emptyFilters,
  Filters,
  matchesTaskFilters,
  toggleFilter,
} from "./tasks-filters.ts";

const Draft = Schema.Struct({
  ...TaskUpdate.fields,
  id: ItemId,
  revision: Schema.NullOr(ItemId),
  title: Schema.String,
  dueOn: Schema.NullOr(Schema.String),
  assignee: TaskAssignee,
});
type Draft = typeof Draft.Type;
const Editor = Schema.Struct({
  draft: Draft,
  tagPicker: Tokenizer.Model,
  tagError: Schema.NullOr(Schema.String),
});
export type Editor = typeof Editor.Type;
const Creation = Schema.Struct({
  ...Editor.fields,
  preserveView: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
const Operation = Schema.Union([
  Schema.TaggedStruct("Load", {}),
  Schema.TaggedStruct("Create", { input: TaskCreate }),
  Schema.TaggedStruct("Save", {
    id: ItemId,
    input: TaskUpdate,
  }),
  Schema.TaggedStruct("Delete", { id: ItemId, input: TaskDelete }),
  Schema.TaggedStruct("AddTag", {
    id: ItemId,
    input: TagCreate,
    skipAttachment: Schema.optionalKey(Schema.Boolean),
  }),
]);
type Operation = typeof Operation.Type;
export const FilterCategory = Schema.Literals(["status", "priority", "tags"]);
export const filterOptionsId = "task-filter-options";
export const creationDialogId = "task-create-dialog";
export const creationTitleId = "task-create-title-input";
export const creationSubmitId = "task-create-submit";
export const addTaskButtonId = "add-task";
export const deleteDialogId = "task-delete-dialog";
export const deleteConflictMessage =
  "The task changed. Close this dialog and review the latest task before deleting it.";
const filterPopover = Popover.init({ id: "task-filters" });
const filterTags = MultiCombobox.init("task-filter-tags");
const closedFilterOptions = { filterCategory: null, filterTags };
const Sort = Schema.Literals(["updated", "priority", "due"]);
const sortMenu = DropdownMenu.SingleSelect.init({ id: "task-sort" });
const rowActions = ItemActionMenu.init("task-row-actions");
type RowAction = "open" | "rename" | Property;
export const taskActionMenu = ItemActionMenu.create<RowAction>();
const closedTaskMenus = {
  filterPopover,
  ...closedFilterOptions,
  sortMenu,
  rowActions,
};
export const taskSortMenu =
  DropdownMenu.SingleSelect.create<typeof Sort.Type>();
const Field = Schema.Literals([
  "title",
  "description",
  "status",
  "priority",
  "dueOn",
  "assignee",
]);

export const Model = Schema.Struct({
  index: Schema.NullOr(TaskSnapshot),
  folderSheet: Sheet.Model,
  selectedId: Schema.NullOr(ItemId),
  edits: Schema.Record(Schema.String, Edits.Draft),
  picker: Schema.NullOr(Picker),
  rename: Schema.NullOr(
    Schema.Struct({
      id: ItemId,
      value: Schema.String,
      invalid: Schema.Boolean,
      revision: ItemId,
    }),
  ),
  tagPickerError: Schema.NullOr(Schema.String),
  attachments: Attachments.Model,
  creation: Schema.NullOr(Creation),
  deleteDialog: Dialog.Model,
  deletion: Schema.NullOr(
    Schema.Struct({
      id: ItemId,
      revision: Schema.NullOr(ItemId),
      title: Schema.String,
      error: Schema.NullOr(Schema.String),
      completed: Schema.Boolean,
    }),
  ),
  filterPopover: Popover.Model,
  filterCategory: Schema.NullOr(FilterCategory),
  filterTags: MultiCombobox.Model,
  filters: Filters,
  sort: Sort,
  sortMenu: DropdownMenu.SingleSelect.Model,
  rowActions: ItemActionMenu.Model,
  request: Schema.NullOr(
    Schema.Struct({ id: Schema.String, operation: Operation }),
  ),
  refreshRequest: Schema.NullOr(Schema.String),
  refreshPending: Schema.Boolean,
  runActivityTime: Schema.Number,
  error: Schema.NullOr(
    Schema.Struct({
      message: Schema.String,
      announcedInCreation: Schema.Boolean,
    }),
  ),
});
export type Model = typeof Model.Type;
export const initial: Model = {
  index: null,
  folderSheet: Sheet.init({ id: "task-views" }),
  selectedId: null,
  edits: {},
  picker: null,
  rename: null,
  tagPickerError: null,
  attachments: Attachments.initial,
  creation: null,
  deleteDialog: Dialog.init({ id: deleteDialogId }),
  deletion: null,
  ...closedTaskMenus,
  filters: defaultFilters,
  sort: "updated",
  request: null,
  refreshRequest: null,
  refreshPending: false,
  runActivityTime: 0,
  error: null,
};

export const Message = defineMessageUnion({
  Opened: { ...TaskRoute.fields, refresh: Schema.Boolean },
  GotFolderSheetMessage: { message: Sheet.Message },
  GotAttachmentsMessage: { message: Attachments.Message },
  CompletedAssigneeAvatarImageMount: {},
  FocusUpdated: {},
  Retried: {},
  RefreshRequested: {},
  RunExpired: { at: Schema.Number },
  RefreshCompleted: {
    check: Schema.String,
    result: Schema.Union([
      TaskSnapshot,
      Schema.Literals(["unchanged", "expired"]),
    ]),
  },
  OpenedCreate: { preserveView: Schema.Boolean },
  ClosedCreate: {},
  Created: {},
  EditedField: { field: Field, value: Schema.String },
  GotFilterPopoverMessage: { message: Popover.Message },
  OpenedFilterCategory: {
    category: FilterCategory,
    focusOptions: Schema.Boolean,
  },
  ClosedFilterCategory: {},
  ToggledStatusFilter: { value: TaskStatus },
  ToggledPriorityFilter: { value: TaskPriority },
  GotFilterTagsMessage: { message: MultiCombobox.Message },
  ClearedFilters: {},
  GotSortMenuMessage: { message: DropdownMenu.SingleSelect.Message },
  GotRowActionMessage: { message: ItemActionMenu.Message },
  GotTagPickerMessage: { id: ItemId, message: Tokenizer.Message },
  RemovedTag: { id: ItemId },
  EditedText: { id: ItemId, field: Edits.TextField, value: Schema.String },
  BlurredText: { id: ItemId, field: Edits.TextField },
  TextDebounced: { id: ItemId, field: Edits.TextField, timer: Schema.String },
  LeftTaskView: {},
  EditedRename: { id: ItemId, value: Schema.String },
  CommittedRename: { id: ItemId },
  CanceledRename: { id: ItemId },
  RetriedEdit: { id: ItemId },
  DiscardedEdit: { id: ItemId },
  GotPropertyPopover: { target: PickerTarget, message: Popover.Message },
  GotPropertySearch: { target: PickerTarget, message: MultiCombobox.Message },
  GotPropertyCalendar: {
    target: PickerTarget,
    message: CalendarPicker.Message,
  },
  FocusedPropertyCalendar: { target: PickerTarget },
  RequestedDelete: {},
  ConfirmedDelete: {},
  GotDeleteDialogMessage: { message: Dialog.Message },
  Loaded: { request: Schema.String, index: TaskSnapshot },
  TaskCreated: { request: Schema.String, task: Task },
  TaskSaved: { request: Schema.String, task: Task, conflict: Schema.Boolean },
  TaskDeleted: { request: Schema.String, id: ItemId },
  DeleteConflict: { request: Schema.String },
  TagCreated: { request: Schema.String, tag: Tag },
  Failed: { request: Schema.String, error: Schema.String },
  SessionExpired: { request: Schema.String },
});
export type Message = typeof Message.Type;
export const OutMessage = defineMessageUnion({
  OpenTask: { id: ItemId },
  OpenList: {},
  SessionExpired: {},
});
export type OutMessage = typeof OutMessage.Type;

export const toAttachmentsMessage = (
  message: typeof Attachments.Message.Type,
) => Message.GotAttachmentsMessage({ message });

const foldAttachments = Update.foldChild({
  update: Attachments.update,
  read: (model: Model) => Option.some(model.attachments),
  write: (model, attachments) => ({ ...model, attachments }),
  toParentMessage: toAttachmentsMessage,
  foldOutMessage: () => (model) => ({
    model,
    outMessage: OutMessage.SessionExpired(),
  }),
});

export const toFolderSheetMessage = (message: typeof Sheet.Message.Type) =>
  Message.GotFolderSheetMessage({ message });
export const closeFolderSheet = () =>
  toFolderSheetMessage(Sheet.Message.RequestedClose());

const foldFolderSheet = Update.foldChild({
  update: Sheet.update,
  read: (model: Model) => Option.some(model.folderSheet),
  write: (model, folderSheet) => ({ ...model, folderSheet }),
  toParentMessage: toFolderSheetMessage,
  foldOutMessage: () => (model) => ({ model }),
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

export const toFilterPopoverMessage = (message: typeof Popover.Message.Type) =>
  Message.GotFilterPopoverMessage({ message });

const foldFilterPopover = Update.foldChild({
  update: Popover.update,
  read: (model: Model) => Option.some(model.filterPopover),
  write: (model, filterPopover) => ({ ...model, filterPopover }),
  toParentMessage: toFilterPopoverMessage,
  foldOutMessage: (out) => (model) => ({
    model: out._tag === "Closed" ? { ...model, ...closedFilterOptions } : model,
  }),
});

export const toSortMenuMessage = (
  message: typeof DropdownMenu.SingleSelect.Message.Type,
) => Message.GotSortMenuMessage({ message });

const foldSortMenu = Update.foldChild({
  update: taskSortMenu.update,
  read: (model: Model) => Option.some(model.sortMenu),
  write: (model, sortMenu) => ({ ...model, sortMenu }),
  toParentMessage: toSortMenuMessage,
  foldOutMessage:
    ({ value }) =>
    (model) => ({
      model: Schema.is(Sort)(value) ? { ...model, sort: value } : model,
    }),
});

export const toFilterTagsMessage = (
  message: typeof MultiCombobox.Message.Type,
) => Message.GotFilterTagsMessage({ message });

const foldFilterTags = Update.foldChild({
  update: MultiCombobox.update,
  read: (model: Model) =>
    model.filterCategory === "tags"
      ? Option.some(model.filterTags)
      : Option.none(),
  write: (model, filterTags) => ({ ...model, filterTags }),
  toParentMessage: toFilterTagsMessage,
  foldOutMessage: (out) => (model) => ({
    model:
      out._tag === "Selected"
        ? {
            ...model,
            filters: {
              ...model.filters,
              tagIds: toggleFilter(model.filters.tagIds, out.value),
            },
          }
        : model,
  }),
});

const FocusFilterOptions = Command.define("FocusTaskFilterOptions", {
  messages: [Message.FocusUpdated],
  execute: focus(`#${filterOptionsId} input`, { preventScroll: true }).pipe(
    Effect.ignore,
    Effect.as(Message.FocusUpdated()),
  ),
});

const FocusFilterTrigger = Command.define("FocusTaskFilterTrigger", {
  messages: [Message.FocusUpdated],
  execute: focus(`#${Popover.buttonId(filterPopover.id)}`, {
    preventScroll: true,
  }).pipe(Effect.ignore, Effect.as(Message.FocusUpdated())),
});

const FocusList = Command.define("FocusTaskList", {
  args: { id: ItemId },
  messages: [Message.FocusUpdated],
  execute: ({ id }) => {
    const list = ".tasks-workspace:not([data-panel]) .task-list";
    return focus(`${list} [data-task-id="${id}"]`, {
      preventScroll: true,
    }).pipe(
      Effect.catch(() => focus(list, { preventScroll: true })),
      Effect.ignore,
      Effect.as(Message.FocusUpdated()),
    );
  },
});

const RecoverTaskRowFocus = Command.define("RecoverTaskRowFocus", {
  args: { rowId: Schema.NullOr(ItemId), preferLink: Schema.Boolean },
  messages: [Message.FocusUpdated],
  execute: ({ rowId, preferLink }) =>
    Render.afterCommit.pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (document.activeElement === document.body) {
            const trigger =
              rowId && !preferLink
                ? document.getElementById(
                    ItemActionMenu.triggerId(rowActions.id, rowId),
                  )
                : null;
            const link = rowId
              ? document.getElementById(
                  ItemActionMenu.rowLinkId(rowActions.id, rowId),
                )
              : null;
            const addButton = document.querySelector<HTMLButtonElement>(
              `.tasks-workspace:not([data-panel]) #${addTaskButtonId}`,
            );
            (trigger?.getClientRects().length
              ? trigger
              : (link ?? addButton)
            )?.focus();
          }
          return Message.FocusUpdated();
        }),
      ),
    ),
});

const FocusCreateSubmit = Command.define("FocusTaskCreateSubmit", {
  messages: [Message.FocusUpdated],
  execute: focus(`#${creationSubmitId}`).pipe(
    Effect.ignore,
    Effect.as(Message.FocusUpdated()),
  ),
});

const FocusRetryTarget = Command.define("FocusTaskRetryTarget", {
  args: { inCreation: Schema.Boolean },
  messages: [Message.FocusUpdated],
  execute: ({ inCreation }) =>
    focus(
      inCreation
        ? `#${creationTitleId}`
        : ".tasks-workspace.workspace-stacked > .workspace-header",
      { preventScroll: true },
    ).pipe(Effect.ignore, Effect.as(Message.FocusUpdated())),
});

const FocusEditor = Command.define("FocusTaskEditor", {
  args: { selector: Schema.String },
  messages: [Message.FocusUpdated],
  execute: ({ selector }) =>
    Render.afterCommit.pipe(
      Effect.andThen(focus(selector, { preventScroll: true })),
      Effect.ignore,
      Effect.as(Message.FocusUpdated()),
    ),
});

const FocusPropertyCalendar = Command.define("FocusTaskPropertyCalendar", {
  args: { target: PickerTarget, selector: Schema.String },
  messages: [Message.FocusedPropertyCalendar],
  execute: ({ target, selector }) =>
    Render.afterCommit.pipe(
      Effect.andThen(focus(selector, { preventScroll: true })),
      Effect.ignore,
      Effect.as(Message.FocusedPropertyCalendar({ target })),
    ),
});

const DebounceText = Command.define("DebounceTaskText", {
  args: { id: ItemId, field: Edits.TextField, timer: Schema.String },
  messages: [Message.TextDebounced],
  execute: (args) =>
    Effect.sleep(500).pipe(Effect.as(Message.TextDebounced(args))),
});

const requestJson = async <A>(
  signal: AbortSignal,
  schema: Schema.Decoder<A>,
  path: string,
  write?: { method: "POST" | "PUT"; input: unknown },
) => {
  const response = await fetch(path, {
    signal,
    cache: "no-store",
    ...(write
      ? {
          method: write.method,
          headers: {
            "content-type": "application/json",
            "x-effect-auth-csrf": "1",
          },
          body: JSON.stringify(write.input),
        }
      : {}),
  });
  if (response.status === 401) return null;
  const conflict = write?.method === "PUT" && response.status === 409;
  if (!response.ok && !conflict) throw new Error("Task request failed.");
  const value = Schema.decodeUnknownSync(schema)(await response.json());
  return { value, conflict };
};

const Request = Command.define("RequestTasks", {
  args: { request: Schema.String, operation: Operation },
  messages: [
    Message.Loaded,
    Message.TaskCreated,
    Message.TaskSaved,
    Message.TaskDeleted,
    Message.DeleteConflict,
    Message.TagCreated,
    Message.Failed,
    Message.SessionExpired,
  ],
  execute: ({ request, operation }) =>
    Effect.tryPromise(async (signal) => {
      switch (operation._tag) {
        case "Load": {
          const result = await requestJson(signal, TaskSnapshot, tasksApi);
          if (result) return Message.Loaded({ request, index: result.value });
          break;
        }
        case "Create": {
          const result = await requestJson(signal, Task, tasksApi, {
            method: "POST",
            input: operation.input,
          });
          if (result)
            return Message.TaskCreated({ request, task: result.value });
          break;
        }
        case "Save": {
          const result = await requestJson(
            signal,
            Task,
            taskApi(operation.id),
            {
              method: "PUT",
              input: operation.input,
            },
          );
          if (result)
            return Message.TaskSaved({
              request,
              task: result.value,
              conflict: result.conflict,
            });
          break;
        }
        case "Delete": {
          const response = await fetch(taskApi(operation.id), {
            method: "DELETE",
            signal,
            headers: {
              "content-type": "application/json",
              "x-effect-auth-csrf": "1",
            },
            body: JSON.stringify(operation.input),
          });
          if (response.status === 401) break;
          if (response.status === 409)
            return Message.DeleteConflict({ request });
          if (response.status === 204 || response.status === 404)
            return Message.TaskDeleted({ request, id: operation.id });
          throw new Error("Task deletion failed.");
        }
        case "AddTag": {
          const result = await requestJson(signal, Tag, tagsApi, {
            method: "POST",
            input: operation.input,
          });
          if (result) return Message.TagCreated({ request, tag: result.value });
          break;
        }
      }
      return Message.SessionExpired({ request });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          Message.Failed({
            request,
            error: {
              Load: "Could not load tasks. Try again.",
              Create: "Could not add the task. Try again.",
              Save: "Could not save the task. Try again.",
              Delete: "Could not delete the task. Try again.",
              AddTag: "Could not add the tag. Try again.",
            }[operation._tag],
          }),
        ),
      ),
    ),
});

const CheckVersion = Command.define("CheckTaskVersion", {
  args: { check: Schema.String, version: TaskSnapshot.fields.version },
  messages: [Message.RefreshCompleted],
  execute: ({ check, version }) =>
    Effect.tryPromise((signal) =>
      checkIndex(tasksApi, version, TaskSnapshot, signal),
    ).pipe(
      Effect.map((result) => Message.RefreshCompleted({ check, result })),
      Effect.orElseSucceed(() =>
        Message.RefreshCompleted({ check, result: "unchanged" }),
      ),
    ),
});

const isCreationWrite = (model: Model, operation: Operation | undefined) =>
  operation?._tag === "Create" ||
  (operation?._tag === "AddTag" && operation.id === model.creation?.draft.id);

const start = (
  model: Model,
  operation: Operation,
): Update.Return<Model, Message> => {
  if (model.request) return { model };
  const id = crypto.randomUUID();
  return {
    model: {
      ...model,
      request: { id, operation },
      // A read started before this operation may return after the write settles.
      refreshRequest: null,
      refreshPending: model.refreshPending || model.refreshRequest !== null,
      error: isCreationWrite(model, operation) ? model.error : null,
    },
    commands: [Request({ request: id, operation })],
  };
};

export const selectedTask = (model: Model) =>
  model.index?.tasks.find((task) => task.id === model.selectedId) ?? null;

const priorityRank = { "": 0, low: 1, medium: 2, high: 3, urgent: 4 };
export const visibleTasks = ({ index, filters, sort }: Model) =>
  (index?.tasks ?? [])
    .filter((task) => matchesTaskFilters(task, filters))
    .sort((left, right) => {
      if (sort === "priority") {
        const order =
          priorityRank[right.priority ?? ""] -
          priorityRank[left.priority ?? ""];
        if (order) return order;
      }
      if (sort === "due") {
        const order = (left.dueOn ?? "9999-99-99").localeCompare(
          right.dueOn ?? "9999-99-99",
        );
        if (order) return order;
      }
      return (
        right.updatedAt - left.updatedAt || right.id.localeCompare(left.id)
      );
    });

export const writingCreation = (model: Model) =>
  isCreationWrite(model, model.request?.operation);

const toDraft = ({
  id,
  revision,
  title,
  description,
  status,
  priority,
  dueOn,
  assignee,
  tagIds,
}: Task) => ({
  id,
  revision,
  title,
  description,
  status,
  priority,
  dueOn,
  assignee,
  tagIds,
});

const makeEditor = (draft: Draft): Editor => ({
  draft,
  tagPicker: Tokenizer.init({ id: `task-tags-${draft.id}` }),
  tagError: null,
});

const withEditor = (model: Model, editor: Editor): Model =>
  model.creation?.draft.id === editor.draft.id
    ? { ...model, creation: { ...model.creation, ...editor } }
    : model;

const editField = (
  draft: Draft,
  field: typeof Field.Type,
  value: string,
): Draft => {
  switch (field) {
    case "status":
      return Schema.is(TaskStatus)(value) ? { ...draft, status: value } : draft;
    case "priority": {
      const priority = value || null;
      return Schema.is(TaskPriority)(priority) ? { ...draft, priority } : draft;
    }
    case "dueOn":
      return { ...draft, dueOn: value || null };
    case "assignee": {
      const assignee = value || null;
      return Schema.is(TaskAssignee)(assignee) ? { ...draft, assignee } : draft;
    }
    default:
      return { ...draft, [field]: value };
  }
};

export const toRowActionMessage = (
  message: typeof ItemActionMenu.Message.Type,
) => Message.GotRowActionMessage({ message });

const findTask = (model: Model, id: string) =>
  model.index?.tasks.find((task) => task.id === id);

export const editedTask = (model: Model, task: Task) =>
  Edits.overlay(task, model.edits[task.id]);

const setDraft = (
  model: Model,
  id: string,
  draft: Edits.Draft | undefined,
): Model => {
  const edits = { ...model.edits };
  if (
    draft &&
    (draft.flight ||
      draft.error ||
      Edits.changed(draft.pending) ||
      Object.keys(draft.text).length)
  )
    edits[id] = draft;
  else delete edits[id];
  return { ...model, edits };
};

const stageEdit = (
  model: Model,
  task: Task,
  patch: Edits.Patch,
  revision = task.revision,
) =>
  setDraft(
    model,
    task.id,
    Edits.stage(
      task,
      model.edits[task.id] ?? {
        ...Edits.init(task),
        revision,
      },
      patch,
    ),
  );

const flushText = (
  model: Model,
  id: string,
  field: Edits.TextField,
  blur: boolean,
) => {
  const task = findTask(model, id);
  const draft = model.edits[id];
  return task && draft
    ? setDraft(model, id, Edits.commitText(task, draft, field, blur))
    : model;
};

const finishRename = (model: Model, id: string, cancel: boolean) => {
  const rename = model.rename;
  if (rename?.id !== id) return { model };
  const task = findTask(model, id);
  const title = rename.value.trim();
  if (!cancel && !title)
    return { model: { ...model, rename: { ...rename, invalid: true } } };
  const next = { ...model, rename: null };
  return {
    model:
      !cancel && task
        ? stageEdit(next, task, { title }, rename.revision)
        : next,
    commands: [RecoverTaskRowFocus({ rowId: id, preferLink: true })],
  };
};

const updatePopover = (
  model: Model,
  target: PickerTarget,
  message: typeof Popover.Message.Type,
): Update.Return<Model, Message> => {
  const id = pickerId(target);
  const picker =
    model.picker && pickerId(model.picker) === id ? model.picker : null;
  if (
    !picker &&
    !["RequestedOpen", "PressedPointerOnButton", "ClickedButton"].includes(
      message._tag,
    )
  )
    return { model };
  if (
    !findTask(model, target.id) ||
    (picker?.calendarFocusing && message._tag === "BlurredPanel")
  )
    return { model };
  const base = picker?.popover ?? Popover.init({ id });
  const result = Popover.update(base, message);
  if (!picker && !result.model.isOpen) return { model };
  const opening = result.model.isOpen && !base.isOpen;
  const closingMenu =
    target.surface === "menu" && base.isOpen && !result.model.isOpen;
  return {
    model: {
      ...model,
      tagPickerError: opening ? null : model.tagPickerError,
      picker: {
        ...(opening || !picker ? initPicker(target) : picker),
        popover: result.model,
      },
    },
    commands: closingMenu
      ? [RecoverTaskRowFocus({ rowId: target.id, preferLink: false })]
      : Command.mapMessages(result.commands ?? [], (message) =>
          Message.GotPropertyPopover({ target, message }),
        ),
  };
};

const chooseProperty = (
  model: Model,
  picker: Picker,
  value: string,
  fromCalendar = false,
): Update.Return<Model, Message> => {
  const task = findTask(model, picker.id);
  if (!task) return { model };
  const { field } = picker;
  const current = editedTask(model, task);
  if (field === "tagIds") {
    const { choices } = tagChoices(
      picker.search.inputValue,
      current.tagIds,
      model.index?.tags ?? [],
    );
    if (
      value !== clearChoice &&
      !choices.some(({ id, disabled }) => id === value && !disabled)
    )
      return { model };
    if (value.startsWith(createTagPrefix))
      return start(
        { ...model, tagPickerError: null },
        {
          _tag: "AddTag",
          id: task.id,
          input: { name: value.slice(createTagPrefix.length) },
        },
      );
    const clearing = value === clearChoice;
    const tagIds = clearing ? [] : toggleFilter(current.tagIds, value);
    const request = model.request;
    const cancelAttachment =
      clearing &&
      request?.operation._tag === "AddTag" &&
      request.operation.id === task.id;
    return {
      model: stageEdit(
        {
          ...model,
          ...(cancelAttachment
            ? {
                request: {
                  ...request,
                  operation: { ...request.operation, skipAttachment: true },
                },
              }
            : {}),
          picker: {
            ...picker,
            search: { ...picker.search, maybeActiveItemIndex: Option.none() },
          },
        },
        task,
        { tagIds },
      ),
    };
  }
  if (field === "dueOn" && value === calendarChoice) {
    const calendar = taskCalendar(picker, current.dueOn);
    return {
      model: {
        ...model,
        picker: { ...picker, calendar, calendarFocusing: true },
      },
      commands: [
        FocusPropertyCalendar({
          target: {
            id: picker.id,
            field: picker.field,
            surface: picker.surface,
          },
          selector: `#${calendar.id}-grid`,
        }),
      ],
    };
  }
  let patch: Edits.Patch;
  if (field === "dueOn") {
    const date =
      value === clearChoice
        ? null
        : fromCalendar
          ? value
          : dueChoices(picker.today).find(({ id }) => id === value)?.date;
    if (date !== null && !Schema.is(TaskDate)(date)) return { model };
    patch = { dueOn: date };
  } else {
    const fields = editField(toDraft(current), field, value);
    patch = { [field]: fields[field] };
  }
  return updatePopover(
    stageEdit(model, task, patch),
    picker,
    Popover.Message.RequestedClose(),
  );
};

const updateSearch = (
  model: Model,
  target: PickerTarget,
  message: typeof MultiCombobox.Message.Type,
): Update.Return<Model, Message> => {
  const picker = model.picker;
  if (!picker?.popover.isOpen || pickerId(picker) !== pickerId(target))
    return { model };
  const result = MultiCombobox.update(picker.search, message);
  const current = { ...picker, search: result.model };
  const next = {
    ...model,
    picker: current,
    tagPickerError:
      message._tag === "UpdatedInputValue" ? null : model.tagPickerError,
  };
  if (result.outMessage?._tag === "Selected")
    return chooseProperty(next, current, result.outMessage.value);
  return {
    model: next,
    commands: Command.mapMessages(result.commands ?? [], (message) =>
      Message.GotPropertySearch({ target, message }),
    ),
  };
};

const foldRowAction = Update.foldChild({
  update: taskActionMenu.update,
  read: (model: Model) => Option.some(model.rowActions),
  write: (model, rowActions) => ({ ...model, rowActions }),
  toParentMessage: toRowActionMessage,
  foldOutMessage:
    ({ key, action }): Update.StepWithOutMessage<Model, Message, OutMessage> =>
    (model) => {
      const task = model.index?.tasks.find(({ id }) => id === key);
      if (!task || !matchesTaskFilters(task, model.filters)) return { model };
      if (action === "open")
        return { model, outMessage: OutMessage.OpenTask({ id: task.id }) };
      if (action === "rename")
        return {
          model: {
            ...model,
            rename: {
              id: task.id,
              value: editedTask(model, task).title,
              invalid: false,
              revision: task.revision,
            },
          },
          commands: [FocusEditor({ selector: `#task-rename-${task.id}` })],
        };
      const target = { id: task.id, field: action, surface: "menu" } as const;
      return updatePopover(model, target, Popover.Message.RequestedOpen());
    },
});

const attach = (draft: Draft, id: string): Draft =>
  draft.tagIds.includes(id) || draft.tagIds.length >= taskTagLimit
    ? draft
    : { ...draft, tagIds: [...draft.tagIds, id] };

export const tagSearch = (editor: Editor, tags: readonly Tag[]) =>
  searchTags(
    editor.tagPicker.inputValue,
    editor.draft.tagIds,
    tags,
    editor.tagError,
  );

const toTagPickerMessage =
  (id: string) => (message: typeof Tokenizer.Message.Type) =>
    Message.GotTagPickerMessage({ id, message });

const afterTagSelection = (editor: Editor, draft: Draft): Editor => ({
  ...editor,
  draft,
  tagError: null,
  tagPicker:
    draft.tagIds.length >= taskTagLimit
      ? Tokenizer.init({ id: editor.tagPicker.id })
      : {
          ...editor.tagPicker,
          inputValue: "",
          maybeActiveItemIndex: Option.none(),
        },
});

const replaceTask = (model: Model, task: Task): Model => ({
  ...model,
  index: model.index && {
    ...model.index,
    tasks: [task, ...model.index.tasks.filter(({ id }) => id !== task.id)],
  },
});

const applyIndex = (model: Model, index: typeof TaskSnapshot.Type): Model => {
  const next = { ...model, index, runActivityTime: Date.now() };
  const availableTags = new Set(index.tags.map(({ id }) => id));
  const availableTagIds = (ids: readonly string[]) =>
    ids.filter((id) => availableTags.has(id));
  const refreshEditorTags = <A extends Editor>(editor: A): A => ({
    ...editor,
    draft: { ...editor.draft, tagIds: availableTagIds(editor.draft.tagIds) },
  });
  return {
    ...next,
    filters: {
      ...model.filters,
      tagIds: availableTagIds(model.filters.tagIds),
    },
    creation: model.creation && refreshEditorTags(model.creation),
  };
};

export const nextRunExpiry = (model: Model) => {
  let next: number | null = null;
  for (const { latestRun } of model.index?.tasks ?? []) {
    const expiresAt = latestRun?.expiresAt;
    if (expiresAt != null && expiresAt > model.runActivityTime)
      next = Math.min(next ?? expiresAt, expiresAt);
  }
  return next;
};

const transition = (
  model: Model,
  message: Message,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> => {
  if (
    "request" in message &&
    message.request !== model.request?.id &&
    !Object.values(model.edits).some(
      (draft) => draft.flight?.request === message.request,
    )
  )
    return { model };
  return Message.match<Update.ReturnWithOutMessage<Model, Message, OutMessage>>(
    message,
    {
      Opened: ({ id, refresh }) => {
        const next =
          id !== model.selectedId
            ? {
                ...model,
                ...closedTaskMenus,
                selectedId: id,
                picker: null,
                rename: null,
                attachments: Attachments.initial,
                creation: null,
                deletion: null,
                error: null,
              }
            : refresh
              ? {
                  ...model,
                  ...closedTaskMenus,
                  ...(model.creation ? { creation: null, error: null } : {}),
                }
              : model;
        return Update.combine(next, [
          (next) =>
            id !== model.selectedId && next.deleteDialog.isOpen
              ? foldDeleteDialog(next, Dialog.Message.RequestedClose())
              : { model: next },
          (next) =>
            !next.index
              ? start(next, { _tag: "Load" })
              : { model: refresh ? { ...next, refreshPending: true } : next },
          (next) => ({
            model: next,
            commands:
              !refresh && id === null && model.selectedId
                ? [FocusList({ id: model.selectedId })]
                : [],
          }),
        ]);
      },
      GotFolderSheetMessage: ({ message }) => foldFolderSheet(model, message),
      GotAttachmentsMessage: ({ message }) =>
        (message._tag === "Opened" || message._tag === "Picked") &&
        message.taskId !== model.selectedId
          ? { model }
          : foldAttachments(model, message),
      CompletedAssigneeAvatarImageMount: () => ({ model }),
      FocusUpdated: () => ({ model }),
      RunExpired: ({ at }) => ({
        model: {
          ...model,
          runActivityTime: Math.max(model.runActivityTime, at),
        },
      }),
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
      Retried: () => {
        const result = start(model, { _tag: "Load" });
        return result.commands
          ? {
              model: result.model,
              commands: [
                FocusRetryTarget({ inCreation: model.creation !== null }),
                ...result.commands,
              ],
            }
          : result;
      },
      OpenedCreate: ({ preserveView }) => {
        if (
          model.creation ||
          model.deletion ||
          (!preserveView && (model.request || !model.index))
        )
          return { model };
        const next = {
          ...model,
          refreshPending:
            model.refreshPending || (preserveView && model.index !== null),
          creation: {
            ...makeEditor({
              id: crypto.randomUUID(),
              revision: null,
              title: "",
              description: "",
              status: defaultTaskStatus,
              priority: null,
              dueOn: null,
              assignee: "owner",
              tagIds: [],
            }),
            preserveView,
            error: null,
          },
        };
        return model.index ? { model: next } : start(next, { _tag: "Load" });
      },
      ClosedCreate: () => ({
        model:
          model.creation && !writingCreation(model)
            ? { ...model, creation: null }
            : model,
      }),
      Created: () => {
        if (model.request || !model.creation || !model.index) return { model };
        const { revision: _, ...fields } = model.creation.draft;
        const input = { ...fields, title: fields.title.trim() };
        if (!Schema.is(TaskCreate)(input))
          return {
            model: {
              ...model,
              creation: {
                ...model.creation,
                error: "Check the task title, due date and other fields.",
              },
            },
          };
        const result = start(
          { ...model, creation: { ...model.creation, error: null } },
          { _tag: "Create", input },
        );
        return {
          model: result.model,
          commands: [FocusCreateSubmit(), ...(result.commands ?? [])],
        };
      },
      EditedField: ({ field, value }) => {
        const editor = model.creation;
        const loadingCreation =
          model.creation && model.request?.operation._tag === "Load";
        return {
          model:
            editor && (!model.request || loadingCreation)
              ? withEditor(model, {
                  ...editor,
                  draft: editField(editor.draft, field, value),
                })
              : model,
        };
      },
      GotFilterPopoverMessage: ({ message }) =>
        foldFilterPopover(model, message),
      OpenedFilterCategory: ({ category, focusOptions }) => {
        if (!model.filterPopover.isOpen) return { model };
        return {
          model:
            model.filterCategory === category
              ? model
              : { ...model, filterCategory: category, filterTags },
          ...(focusOptions ? { commands: [FocusFilterOptions()] } : {}),
        };
      },
      ClosedFilterCategory: () => ({
        model: { ...model, ...closedFilterOptions },
      }),
      ToggledStatusFilter: ({ value }) => ({
        model: {
          ...model,
          filters: {
            ...model.filters,
            statuses: toggleFilter(model.filters.statuses, value),
          },
        },
      }),
      ToggledPriorityFilter: ({ value }) => ({
        model: {
          ...model,
          filters: {
            ...model.filters,
            priorities: toggleFilter(model.filters.priorities, value),
          },
        },
      }),
      GotFilterTagsMessage: ({ message }) => foldFilterTags(model, message),
      ClearedFilters: () => {
        const cleared = { ...model, filters: emptyFilters };
        return model.filterPopover.isOpen
          ? foldFilterPopover(cleared, Popover.Message.RequestedClose())
          : { model: cleared, commands: [FocusFilterTrigger()] };
      },
      GotSortMenuMessage: ({ message }) => foldSortMenu(model, message),
      GotRowActionMessage: ({ message }) =>
        model.selectedId === null && model.creation === null
          ? foldRowAction(model, message)
          : { model },
      GotTagPickerMessage: ({ id, message }) => {
        const editor = model.creation;
        if (
          editor?.draft.id !== id ||
          editor.draft.tagIds.length >= taskTagLimit
        )
          return { model };
        const { draft } = editor;
        const result = Tokenizer.update(editor.tagPicker, message);
        const updated = {
          ...editor,
          tagPicker: result.model,
          tagError:
            message._tag === "UpdatedInputValue" ? null : editor.tagError,
        };
        const next = withEditor(model, updated);
        const commands = Command.mapMessages(
          result.commands ?? [],
          toTagPickerMessage(id),
        );
        const selection = result.outMessage;
        if (model.request || selection?._tag !== "Selected")
          return { model: next, commands };
        if (selection.value.startsWith(createTagPrefix)) {
          const { name, canCreate } = tagSearch(
            updated,
            model.index?.tags ?? [],
          );
          return canCreate && selection.value === `${createTagPrefix}${name}`
            ? start(next, { _tag: "AddTag", id: draft.id, input: { name } })
            : { model: next, commands };
        }
        return {
          model: model.index?.tags.some((tag) => tag.id === selection.value)
            ? withEditor(
                model,
                afterTagSelection(updated, attach(draft, selection.value)),
              )
            : next,
          commands,
        };
      },
      RemovedTag: ({ id }) => {
        const editor = model.creation;
        if (!editor || model.request) return { model };
        return {
          model: withEditor(model, {
            ...editor,
            draft: {
              ...editor.draft,
              tagIds: editor.draft.tagIds.filter((tagId) => tagId !== id),
            },
          }),
          commands: Command.mapMessages(
            [Tokenizer.FocusInput({ id: editor.tagPicker.id })],
            toTagPickerMessage(editor.draft.id),
          ),
        };
      },
      EditedText: ({ id, field, value }) => {
        const task = findTask(model, id);
        if (!task) return { model };
        const draft = model.edits[id] ?? Edits.init(task);
        const timer =
          field === "title" && !value.trim() ? null : crypto.randomUUID();
        const pending = { ...draft.pending };
        delete pending[field];
        return {
          model: setDraft(model, id, {
            ...draft,
            pending,
            text: { ...draft.text, [field]: { value, timer } },
          }),
          commands: timer ? [DebounceText({ id, field, timer })] : [],
        };
      },
      BlurredText: ({ id, field }) => ({
        model: flushText(model, id, field, true),
      }),
      TextDebounced: ({ id, field, timer }) => ({
        model:
          model.edits[id]?.text[field]?.timer === timer
            ? flushText(model, id, field, false)
            : model,
      }),
      LeftTaskView: () => {
        let next: Model = { ...model, picker: null };
        for (const id of Object.keys(model.edits)) {
          next = flushText(
            flushText(next, id, "title", true),
            id,
            "description",
            true,
          );
        }
        if (next.rename) next = finishRename(next, next.rename.id, false).model;
        return { model: { ...next, rename: null } };
      },
      EditedRename: ({ id, value }) => ({
        model:
          model.rename?.id === id
            ? { ...model, rename: { ...model.rename, value, invalid: false } }
            : model,
      }),
      CommittedRename: ({ id }) => finishRename(model, id, false),
      CanceledRename: ({ id }) => finishRename(model, id, true),
      RetriedEdit: ({ id }) => {
        const task = findTask(model, id);
        const next = flushText(
          flushText(model, id, "title", true),
          id,
          "description",
          true,
        );
        const draft = next.edits[id];
        if (!task || !draft?.error) return { model };
        return {
          model: setDraft(
            next,
            id,
            Edits.stage(
              task,
              {
                ...draft,
                error: null,
                revision:
                  draft.error === "conflict" ? task.revision : draft.revision,
              },
              {},
            ),
          ),
        };
      },
      DiscardedEdit: ({ id }) => ({ model: setDraft(model, id, undefined) }),
      GotPropertyPopover: ({ target, message }) =>
        updatePopover(model, target, message),
      GotPropertySearch: ({ target, message }) =>
        updateSearch(model, target, message),
      FocusedPropertyCalendar: ({ target }) => ({
        model:
          model.picker && pickerId(model.picker) === pickerId(target)
            ? { ...model, picker: { ...model.picker, calendarFocusing: false } }
            : model,
      }),
      GotPropertyCalendar: ({ target, message }) => {
        const picker = model.picker;
        if (
          !picker?.calendar ||
          !picker.popover.isOpen ||
          pickerId(picker) !== pickerId(target)
        )
          return { model };
        const result = CalendarPicker.update(picker.calendar, message);
        if (result.outMessage?._tag === "SelectedDate") {
          return chooseProperty(
            model,
            picker,
            Temporal.PlainDate.from(result.outMessage.date).toString(),
            true,
          );
        }
        return {
          model: { ...model, picker: { ...picker, calendar: result.model } },
          commands: Command.mapMessages(result.commands ?? [], (message) =>
            Message.GotPropertyCalendar({ target, message }),
          ),
        };
      },
      RequestedDelete: () => {
        const task = selectedTask(model);
        if (!task || model.request || model.creation || model.deletion)
          return { model };
        const { id, revision, title } = task;
        return foldDeleteDialog(
          {
            ...model,
            deletion: { id, revision, title, error: null, completed: false },
          },
          Dialog.Message.RequestedOpen(),
        );
      },
      ConfirmedDelete: () => {
        const { deletion } = model;
        if (
          !deletion?.revision ||
          !model.deleteDialog.isOpen ||
          model.request ||
          Edits.saving(model.edits[deletion.id]) ||
          selectedTask(model)?.revision !== deletion.revision
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
      TaskDeleted: ({ id }) => {
        const next = {
          ...setDraft(model, id, undefined),
          index: model.index && {
            ...model.index,
            tasks: model.index.tasks.filter((task) => task.id !== id),
          },
          request: null,
          refreshPending: true,
        };
        return model.deletion?.id === id && model.deleteDialog.isOpen
          ? foldDeleteDialog(
              {
                ...next,
                attachments: Attachments.initial,
                deletion: { ...model.deletion, completed: true },
              },
              Dialog.Message.RequestedClose(),
            )
          : { model: next };
      },
      DeleteConflict: () => ({
        model: {
          ...model,
          request: null,
          refreshPending: true,
          deletion: model.deletion && {
            ...model.deletion,
            revision: null,
            error: deleteConflictMessage,
          },
        },
      }),
      Loaded: ({ index }) => ({
        model: applyIndex({ ...model, request: null }, index),
      }),
      TaskCreated: ({ task }) => {
        const next = replaceTask({ ...model, request: null }, task);
        if (model.creation?.draft.id !== task.id) return { model: next };
        return {
          model: { ...next, creation: null },
          ...(!model.creation.preserveView && model.selectedId === null
            ? { outMessage: OutMessage.OpenTask({ id: task.id }) }
            : {}),
        };
      },
      TaskSaved: ({ task, conflict }) => {
        const draft = model.edits[task.id];
        if (!draft) return { model };
        const next = replaceTask(model, task);
        const deletion =
          model.deletion?.id === task.id &&
          model.deletion.revision === draft.revision &&
          !conflict
            ? { ...model.deletion, revision: task.revision, title: task.title }
            : model.deletion;
        return {
          model: setDraft(
            { ...next, deletion },
            task.id,
            Edits.settled(task, draft, conflict ? "conflict" : null),
          ),
        };
      },
      TagCreated: ({ tag }) => {
        const tags = model.index?.tags;
        const newTags = tags?.some(({ id }) => id === tag.id)
          ? tags
          : [...(tags ?? []), tag];
        const operation = model.request?.operation;
        const next = {
          ...model,
          index: model.index && { ...model.index, tags: newTags },
          request: null,
        };
        if (operation?._tag !== "AddTag" || operation.skipAttachment)
          return { model: next };
        const editor = model.creation;
        if (editor?.draft.id === operation.id)
          return {
            model: withEditor(
              next,
              afterTagSelection(editor, attach(editor.draft, tag.id)),
            ),
          };
        const task = findTask(next, operation.id);
        if (!task) return { model: next };
        const ids = editedTask(next, task).tagIds;
        return {
          model:
            ids.includes(tag.id) || ids.length >= taskTagLimit
              ? next
              : stageEdit(next, task, { tagIds: [...ids, tag.id] }),
        };
      },
      Failed: ({ request, error }) => {
        const edit = Object.entries(model.edits).find(
          ([, draft]) => draft.flight?.request === request,
        );
        if (edit) {
          const [id, draft] = edit;
          const task = findTask(model, id);
          return {
            model: task
              ? setDraft(
                  { ...model, refreshPending: true },
                  id,
                  Edits.settled(task, draft, "failed"),
                )
              : model,
          };
        }
        const operation = model.request?.operation;
        const next = { ...model, request: null };
        if (operation?._tag === "Delete" && model.deletion)
          return { model: { ...next, deletion: { ...model.deletion, error } } };
        if (operation?._tag === "Create")
          return {
            model: model.creation
              ? { ...next, creation: { ...model.creation, error } }
              : next,
          };
        if (operation?._tag !== "AddTag")
          return {
            model: {
              ...next,
              error: {
                message: error,
                announcedInCreation:
                  operation?._tag === "Load" &&
                  !model.index &&
                  model.creation !== null,
              },
            },
          };
        const editor = model.creation;
        if (editor?.draft.id !== operation.id)
          return {
            model:
              model.picker?.id === operation.id
                ? { ...next, tagPickerError: error }
                : next,
          };
        return {
          model: withEditor(next, {
            ...editor,
            tagError: error,
            tagPicker: {
              ...Tokenizer.init({ id: editor.tagPicker.id }),
              inputValue: operation.input.name,
            },
          }),
        };
      },
      SessionExpired: () => ({
        model,
        outMessage: OutMessage.SessionExpired(),
      }),
    },
  );
};

const drainEdits = (model: Model): Update.Return<Model, Message> => {
  let next = model;
  const commands: Command.Command<Message>[] = [];
  // A full load replaces the index. Let it settle before basing a write on it.
  if (model.request?.operation._tag === "Load") return { model };
  for (const [id, draft] of Object.entries(model.edits)) {
    if (draft.flight || draft.error || !Edits.changed(draft.pending)) continue;
    const task = findTask(next, id);
    if (!task || task.revision !== draft.revision) {
      next = setDraft(next, id, { ...draft, error: "conflict" });
      continue;
    }
    const request = crypto.randomUUID();
    const { id: _, ...fields } = toDraft({ ...task, ...draft.pending });
    next = setDraft(next, id, {
      ...draft,
      pending: {},
      flight: { request, patch: draft.pending },
    });
    commands.push(
      Request({ request, operation: { _tag: "Save", id, input: fields } }),
    );
  }
  if (commands.length)
    next = {
      ...next,
      refreshRequest: null,
      refreshPending: next.refreshPending || next.refreshRequest !== null,
    };
  return { model: next, commands };
};

export const update = (model: Model, message: Message) => {
  let result = transition(model, message);
  const before = result.model;
  if (before.index !== model.index || before.filters !== model.filters) {
    const visible = visibleTasks(before);
    const isVisible = (id: string) => visible.some((task) => task.id === id);
    const row = before.rowActions.row;
    const picker = before.picker;
    result = {
      ...result,
      model: {
        ...before,
        ...(row && !isVisible(row.key) ? { rowActions } : {}),
        ...(picker && picker.surface !== "detail" && !isVisible(picker.id)
          ? { picker: null }
          : {}),
        ...(before.rename && !isVisible(before.rename.id)
          ? { rename: null }
          : {}),
      },
    };
    if (
      !before.selectedId &&
      message._tag === "TaskSaved" &&
      !isVisible(message.task.id)
    ) {
      const position = visibleTasks(model).findIndex(
        ({ id }) => id === message.task.id,
      );
      if (position >= 0)
        result = {
          ...result,
          commands: [
            ...(result.commands ?? []),
            RecoverTaskRowFocus({
              rowId: (visible[position] ?? visible.at(-1))?.id ?? null,
              preferLink: true,
            }),
          ],
        };
    }
  }
  if (result.outMessage?._tag === "SessionExpired") return result;
  const drained = drainEdits(result.model);
  const next = drained.model;
  const commands = [...(result.commands ?? []), ...(drained.commands ?? [])];
  if (
    !next.refreshPending ||
    !next.index ||
    next.request ||
    next.refreshRequest ||
    Object.values(next.edits).some((draft) => draft.flight)
  )
    return { ...result, model: next, commands };

  const check = crypto.randomUUID();
  return {
    ...result,
    model: { ...next, refreshRequest: check, refreshPending: false },
    commands: [
      ...commands,
      CheckVersion({ check, version: next.index.version }),
    ],
  };
};
