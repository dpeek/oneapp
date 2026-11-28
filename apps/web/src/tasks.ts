import {
  CalendarPicker,
  Dialog,
  DropdownMenu,
  MultiCombobox,
  Popover,
  Sheet,
  Tooltip,
} from "@orumai/ui";
import { Temporal } from "@js-temporal/polyfill";
import { Effect, Option, Schema } from "effect";
import { Command, Render, Update } from "foldkit";
import { focus } from "foldkit/dom";
import { defineMessageUnion } from "foldkit/message";
import { ItemId, Tag, TagCreate, tagsApi } from "./items-contract.ts";
import { createTagPrefix } from "./tag-picker.ts";
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
  tagChoices,
  taskCalendar,
} from "./task-properties.ts";
import * as Attachments from "./task-attachments.ts";
import { InlineImageUploads } from "./task-attachment-contract.ts";
import { omitTaskImageBlocks, taskImageIds } from "./task-image-markdown.ts";
import {
  defaultTaskList,
  defaultTaskStatus,
  Task,
  taskApi,
  TaskAssignee,
  TaskCreate,
  TaskDate,
  TaskDelete,
  TaskFields,
  TaskList,
  TaskPriority,
  TaskRoute,
  TaskSnapshot,
  TaskStatus,
  TaskUpdate,
  tasksApi,
  taskDescriptionLimit,
  taskTagLimit,
} from "./tasks-contract.ts";
import {
  emptyFilters,
  Filters,
  matchesTaskFilters,
  taskListFilters,
  toggleFilter,
} from "./tasks-filters.ts";
import { readWorkspaceLayout, WorkspaceLayout } from "./workspace.ts";

const Draft = Schema.Struct({
  ...TaskFields.fields,
  id: ItemId,
  title: Schema.String,
  description: Schema.String,
  assignee: TaskAssignee,
});
const Creation = Schema.Struct({
  draft: Draft,
  titleEdited: Schema.Boolean,
  preserveView: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  screenshots: Schema.Array(Attachments.StagedScreenshot),
  inlineImageUploads: InlineImageUploads,
  validatingScreenshots: Schema.Int,
  saved: Schema.Boolean,
  upload: Schema.NullOr(ItemId),
});
type Creation = typeof Creation.Type;
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
export const FilterCategory = Schema.Literals([
  "status",
  "priority",
  "assignee",
  "tags",
]);
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
const defaultSort = "updated";
const splitViewKey = "orumai.tasks.splitView";
const sortMenu = DropdownMenu.SingleSelect.init({ id: "task-sort" });
const closedTaskMenus = {
  filterPopover,
  ...closedFilterOptions,
  sortMenu,
};
export const taskSortMenu =
  DropdownMenu.SingleSelect.create<typeof Sort.Type>();
export const Model = Schema.Struct({
  index: Schema.NullOr(TaskSnapshot),
  layout: WorkspaceLayout,
  folderSheet: Sheet.Model,
  list: TaskList,
  selectedId: Schema.NullOr(ItemId),
  edits: Schema.Record(Schema.String, Edits.Draft),
  picker: Schema.NullOr(Picker),
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
  request: Schema.NullOr(
    Schema.Struct({ id: Schema.String, operation: Operation }),
  ),
  refreshRequest: Schema.NullOr(Schema.String),
  refreshPending: Schema.Boolean,
  runActivityTime: Schema.Number,
  activityTooltips: Schema.Record(ItemId, Tooltip.Model),
  error: Schema.NullOr(
    Schema.Struct({
      message: Schema.String,
      announcedInCreation: Schema.Boolean,
    }),
  ),
});
export type Model = typeof Model.Type;
export const hasUnsavedChanges = ({ creation, edits, attachments }: Model) => {
  const draft = creation?.draft;
  return (
    (creation !== null &&
      draft !== undefined &&
      (draft.title !== "" ||
        draft.description !== "" ||
        draft.status !== defaultTaskStatus ||
        draft.priority !== null ||
        draft.dueOn !== null ||
        draft.assignee !== "owner" ||
        draft.tagIds.length > 0 ||
        creation.validatingScreenshots > 0)) ||
    Object.values(edits).some(
      (edit) =>
        edit.flight !== null ||
        Edits.changed(edit.pending) ||
        Object.keys(edit.text).length > 0,
    ) ||
    attachments.pending.length > 0
  );
};
export const initial: Model = {
  index: null,
  layout: { wide: false, split: false },
  folderSheet: Sheet.init({ id: "task-views" }),
  list: defaultTaskList,
  selectedId: null,
  edits: {},
  picker: null,
  tagPickerError: null,
  attachments: Attachments.initial,
  creation: null,
  deleteDialog: Dialog.init({ id: deleteDialogId }),
  deletion: null,
  ...closedTaskMenus,
  filters: taskListFilters[defaultTaskList],
  sort: defaultSort,
  request: null,
  refreshRequest: null,
  refreshPending: false,
  runActivityTime: 0,
  activityTooltips: {},
  error: null,
};

export const init = (): Model => ({
  ...initial,
  layout: readWorkspaceLayout(splitViewKey),
});

export const isSplitView = ({ layout }: Model) => layout.wide && layout.split;
export const isListVisible = (model: Model) =>
  model.selectedId === null || isSplitView(model);

export const Message = defineMessageUnion({
  Opened: { ...TaskRoute.fields, refresh: Schema.Boolean },
  ChangedLayoutWidth: { wide: Schema.Boolean },
  ToggledSplitView: {},
  FinishedSavingSplitView: {},
  GotFolderSheetMessage: { message: Sheet.Message },
  GotAttachmentsMessage: { message: Attachments.Message },
  CompletedAssigneeAvatarImageMount: {},
  FocusUpdated: {},
  Retried: {},
  RefreshRequested: {},
  RunExpired: { at: Schema.Number },
  GotActivityTooltipMessage: { id: ItemId, message: Tooltip.Message },
  UnmountedActivityTooltip: { id: ItemId },
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
  DismissedCreate: {},
  GotDraftScreenshot: { message: Attachments.Message },
  RetriedDraftScreenshots: {},
  FinishedDraftScreenshots: {},
  GotFilterPopoverMessage: { message: Popover.Message },
  OpenedFilterCategory: {
    category: FilterCategory,
    focusOptions: Schema.Boolean,
  },
  ClosedFilterCategory: {},
  ToggledStatusFilter: { value: TaskStatus },
  ToggledPriorityFilter: { value: TaskPriority },
  ToggledAssigneeFilter: { value: TaskAssignee },
  GotFilterTagsMessage: { message: MultiCombobox.Message },
  ClearedFilters: {},
  GotSortMenuMessage: { message: DropdownMenu.SingleSelect.Message },
  EditedText: { id: ItemId, field: Edits.TextField, value: Schema.String },
  BlurredText: { id: ItemId, field: Edits.TextField },
  TextDebounced: { id: ItemId, field: Edits.TextField, timer: Schema.String },
  LeftTaskView: {},
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
  OpenList: { mode: Schema.Literals(["push", "replace"]) },
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

const initActivityTooltip = (id: string) =>
  Tooltip.init({ id: `task-activity-${id}` });

export const activityTooltip = (model: Model, id: string) =>
  model.activityTooltips[id] ?? initActivityTooltip(id);

const foldActivityTooltip = Update.foldChildAt({
  update: (model, message: typeof Tooltip.Message.Type) => {
    const { model: next, commands } = Tooltip.update(model, message);
    return { model: next, commands };
  },
  readAt: (model: Model, id: string) =>
    findTask(model, id)?.latestRun
      ? Option.some(activityTooltip(model, id))
      : Option.none(),
  writeAt: (model, id, tooltip) => ({
    ...model,
    activityTooltips: { ...model.activityTooltips, [id]: tooltip },
  }),
  toParentMessage: (id, message) =>
    Message.GotActivityTooltipMessage({ id, message }),
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

const SaveSplitView = Command.define("SaveTaskSplitView", {
  args: { split: Schema.Boolean },
  messages: [Message.FinishedSavingSplitView],
  execute: ({ split }) =>
    Effect.try(() => localStorage.setItem(splitViewKey, String(split))).pipe(
      Effect.ignore,
      Effect.as(Message.FinishedSavingSplitView()),
    ),
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
  args: { rowId: Schema.NullOr(ItemId) },
  messages: [Message.FocusUpdated],
  execute: ({ rowId }) =>
    Render.afterCommit.pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (document.activeElement === document.body) {
            const workspace = document.querySelector(
              ".tasks-workspace:not([data-panel])",
            );
            const link = rowId
              ? workspace?.querySelector<HTMLAnchorElement>(
                  `.task-list [data-task-id="${rowId}"]`,
                )
              : null;
            const addButton = workspace?.querySelector<HTMLButtonElement>(
              `#${addTaskButtonId}`,
            );
            (link ?? addButton)?.focus();
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
  !!model.creation?.upload || isCreationWrite(model, model.request?.operation);

export const creationFieldsLocked = (model: Model) =>
  !!model.creation?.saved || model.request?.operation._tag === "Create";

const draftForPicker = (model: Model, target: PickerTarget) =>
  target.surface === "creation" && model.creation?.draft.id === target.id
    ? model.creation
    : null;

const taskForPicker = (model: Model, target: PickerTarget) =>
  target.surface !== "creation" && !model.creation
    ? findTask(model, target.id)
    : undefined;

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

const stageEdit = (model: Model, task: Task, patch: Edits.Patch) =>
  setDraft(
    model,
    task.id,
    Edits.stage(task, model.edits[task.id] ?? Edits.init(task), patch),
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
    (!draftForPicker(model, target) && !taskForPicker(model, target)) ||
    (target.surface === "creation" && creationFieldsLocked(model)) ||
    (picker?.calendarFocusing && message._tag === "BlurredPanel")
  )
    return { model };
  const base = picker?.popover ?? Popover.init({ id });
  const result = Popover.update(base, message);
  if (!picker && !result.model.isOpen) return { model };
  const opening = result.model.isOpen && !base.isOpen;
  return {
    model: {
      ...model,
      tagPickerError: opening ? null : model.tagPickerError,
      picker: {
        ...(opening || !picker ? initPicker(target) : picker),
        popover: result.model,
      },
    },
    commands: Command.mapMessages(result.commands ?? [], (message) =>
      Message.GotPropertyPopover({ target, message }),
    ),
  };
};

const stageProperty = (
  model: Model,
  picker: PickerTarget,
  patch: Edits.Patch,
) => {
  const creation = draftForPicker(model, picker);
  if (creation)
    return {
      ...model,
      creation: { ...creation, draft: { ...creation.draft, ...patch } },
    };
  const task = taskForPicker(model, picker);
  return task ? stageEdit(model, task, patch) : model;
};

const chooseProperty = (
  model: Model,
  picker: Picker,
  value: string,
  fromCalendar = false,
): Update.Return<Model, Message> => {
  const task = taskForPicker(model, picker);
  const current =
    draftForPicker(model, picker)?.draft ?? (task && editedTask(model, task));
  if (
    !current ||
    (picker.surface === "creation" && creationFieldsLocked(model))
  )
    return { model };
  const { field, id } = picker;
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
          id,
          input: { name: value.slice(createTagPrefix.length) },
        },
      );
    const clearing = value === clearChoice;
    const tagIds = clearing ? [] : toggleFilter(current.tagIds, value);
    const request = model.request;
    const cancelAttachment =
      clearing &&
      request?.operation._tag === "AddTag" &&
      request.operation.id === id;
    return {
      model: stageProperty(
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
        picker,
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
  } else if (field === "status") {
    if (!Schema.is(TaskStatus)(value)) return { model };
    patch = { status: value };
  } else if (field === "priority") {
    const priority = value || null;
    if (!Schema.is(TaskPriority)(priority)) return { model };
    patch = { priority };
  } else {
    const assignee = value || null;
    if (!Schema.is(TaskAssignee)(assignee)) return { model };
    patch = { assignee };
  }
  return updatePopover(
    stageProperty(model, picker, patch),
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
  return {
    ...next,
    filters: {
      ...model.filters,
      tagIds: availableTagIds(model.filters.tagIds),
    },
    creation: model.creation && {
      ...model.creation,
      draft: {
        ...model.creation.draft,
        tagIds: availableTagIds(model.creation.draft.tagIds),
      },
    },
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

export const toDraftScreenshotMessage = (
  message: typeof Attachments.Message.Type,
) => Message.GotDraftScreenshot({ message });

const finishCreation = (
  model: Model,
  creation: Creation,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> => {
  const { id, description } = creation.draft;
  const task = findTask(model, id);
  const next = task
    ? stageEdit(model, task, {
        description: omitTaskImageBlocks(
          description,
          id,
          new Set(creation.screenshots.map((image) => image.id)),
        ),
      })
    : model;
  return {
    model: { ...next, creation: null, picker: null },
    ...(!creation.preserveView
      ? { outMessage: OutMessage.OpenTask({ id }) }
      : {}),
  };
};

const uploadDraftScreenshots = (
  model: Model,
  creation: Creation,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> => {
  const screenshot = creation.screenshots.find(({ error }) => error === null);
  if (!screenshot)
    return creation.screenshots.length
      ? { model: { ...model, creation: { ...creation, upload: null } } }
      : finishCreation(model, creation);

  const { id, name, file } = screenshot;
  return {
    model: {
      ...model,
      creation: { ...creation, upload: id },
    },
    commands: Command.mapMessages(
      [
        Attachments.Run({
          taskId: creation.draft.id,
          id,
          name,
          file,
        }),
      ],
      toDraftScreenshotMessage,
    ),
  };
};

const updateDraftScreenshots = (
  model: Model,
  message: typeof Attachments.Message.Type,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> => {
  const creation = model.creation;
  if (!creation) return { model };
  switch (message._tag) {
    case "Picked":
      if (message.taskId !== creation.draft.id || creationFieldsLocked(model))
        return { model };
      return {
        model: {
          ...model,
          creation: {
            ...creation,
            validatingScreenshots: creation.validatingScreenshots + 1,
          },
        },
        commands: Command.mapMessages(
          [
            Attachments.ValidateDraftScreenshot({
              draftId: creation.draft.id,
              id: message.id,
              file: message.file,
            }),
          ],
          toDraftScreenshotMessage,
        ),
      };
    case "Validated":
      if (message.draftId !== creation.draft.id) return { model };
      return {
        model: {
          ...model,
          creation: {
            ...creation,
            validatingScreenshots: creation.validatingScreenshots - 1,
            screenshots: message.screenshot
              ? [...creation.screenshots, message.screenshot]
              : creation.screenshots,
            inlineImageUploads: {
              ...creation.inlineImageUploads,
              [message.id]: message.screenshot?.file ?? message.error!,
            },
          },
        },
      };
    case "Uploaded":
    case "Failed": {
      const upload = creation.upload;
      if (upload !== message.request) return { model };
      const screenshots =
        message._tag === "Uploaded"
          ? creation.screenshots.filter(({ id }) => id !== upload)
          : creation.screenshots.map((entry) =>
              entry.id === upload ? { ...entry, error: message.error } : entry,
            );
      return uploadDraftScreenshots(model, {
        ...creation,
        screenshots,
        inlineImageUploads: {
          ...creation.inlineImageUploads,
          [upload]: message._tag === "Uploaded" ? true : message.error,
        },
      });
    }
    case "SessionExpired":
      return creation.upload === message.request
        ? { model, outMessage: OutMessage.SessionExpired() }
        : { model };
    default:
      return { model };
  }
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
      ChangedLayoutWidth: ({ wide }) => {
        if (model.layout.wide === wide) return { model };
        const next = { ...model, layout: { ...model.layout, wide } };
        return {
          model:
            isListVisible(model) && !isListVisible(next)
              ? {
                  ...next,
                  ...closedTaskMenus,
                  ...(next.picker?.surface === "row"
                    ? { picker: null, tagPickerError: null }
                    : {}),
                }
              : next,
        };
      },
      ToggledSplitView: () => {
        if (!model.layout.wide) return { model };
        const split = !model.layout.split;
        return {
          model: { ...model, layout: { ...model.layout, split } },
          commands: [SaveSplitView({ split })],
          ...(!split && model.selectedId
            ? { outMessage: OutMessage.OpenList({ mode: "push" }) }
            : {}),
        };
      },
      FinishedSavingSplitView: () => ({ model }),
      Opened: ({ id, list, refresh }) => {
        const nextList = list ?? (refresh ? defaultTaskList : model.list);
        const listChanged = nextList !== model.list;
        let next =
          id !== model.selectedId
            ? {
                ...model,
                ...closedTaskMenus,
                selectedId: id,
                picker: null,
                attachments: Attachments.initial,
                creation: null,
                deletion: null,
                error: null,
              }
            : refresh || listChanged
              ? {
                  ...model,
                  ...closedTaskMenus,
                  ...(model.creation ? { creation: null, error: null } : {}),
                }
              : model;
        if (listChanged)
          next = {
            ...next,
            list: nextList,
            filters: taskListFilters[nextList],
            sort: defaultSort,
          };
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
              !refresh && !listChanged && id === null && model.selectedId
                ? [FocusList({ id: model.selectedId })]
                : [],
          }),
        ]);
      },
      GotFolderSheetMessage: ({ message }) => foldFolderSheet(model, message),
      GotAttachmentsMessage: ({ message }) =>
        message._tag === "Picked" &&
        (message.taskId !== model.selectedId || model.creation !== null)
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
      GotActivityTooltipMessage: ({ id, message }) =>
        foldActivityTooltip(model, id, message),
      UnmountedActivityTooltip: ({ id }) => {
        const tooltip = model.activityTooltips[id];
        if (!tooltip) return { model };
        const activityTooltips = { ...model.activityTooltips };
        if (findTask(model, id)?.latestRun) {
          activityTooltips[id] = {
            ...initActivityTooltip(id),
            pendingShowVersion: tooltip.pendingShowVersion + 1,
          };
        } else {
          delete activityTooltips[id];
        }
        return { model: { ...model, activityTooltips } };
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
        const next: Model = {
          ...model,
          refreshPending:
            model.refreshPending || (preserveView && model.index !== null),
          picker: null,
          creation: {
            draft: {
              id: crypto.randomUUID(),
              title: "",
              description: "",
              status: defaultTaskStatus,
              priority: null,
              dueOn: null,
              assignee: "owner",
              tagIds: [],
            },
            titleEdited: false,
            preserveView,
            error: null,
            screenshots: [],
            inlineImageUploads: {},
            validatingScreenshots: 0,
            saved: false,
            upload: null,
          },
        };
        return model.index ? { model: next } : start(next, { _tag: "Load" });
      },
      DismissedCreate: () =>
        model.picker?.surface === "creation" && model.picker.popover.isOpen
          ? updatePopover(model, model.picker, Popover.Message.RequestedClose())
          : transition(model, Message.ClosedCreate()),
      ClosedCreate: () => ({
        model:
          model.creation && !model.creation.saved && !writingCreation(model)
            ? { ...model, creation: null, picker: null }
            : model,
      }),
      Created: () => {
        const creation = model.creation;
        if (
          model.request ||
          !creation ||
          !model.index ||
          creation.saved ||
          creation.validatingScreenshots
        )
          return { model };
        const draft = { ...creation.draft, title: creation.draft.title.trim() };
        if (!Schema.is(TaskCreate)(draft))
          return {
            model: {
              ...model,
              creation: {
                ...creation,
                titleEdited: true,
                error: "Check the task title, due date and other fields.",
              },
            },
          };
        const result = start(
          { ...model, picker: null, creation: { ...creation, error: null } },
          {
            _tag: "Create",
            input: {
              ...draft,
              description: omitTaskImageBlocks(
                draft.description,
                draft.id,
                new Set(creation.screenshots.map((image) => image.id)),
              ),
            },
          },
        );
        return {
          model: result.model,
          commands: [FocusCreateSubmit(), ...(result.commands ?? [])],
        };
      },
      GotDraftScreenshot: ({ message }) =>
        updateDraftScreenshots(model, message),
      RetriedDraftScreenshots: () => {
        const creation = model.creation;
        return creation?.saved &&
          !creation.upload &&
          creation.screenshots.length
          ? uploadDraftScreenshots(model, {
              ...creation,
              screenshots: creation.screenshots.map((entry) => ({
                ...entry,
                error: null,
              })),
            })
          : { model };
      },
      FinishedDraftScreenshots: () =>
        model.creation?.saved && !model.creation.upload
          ? finishCreation(model, model.creation)
          : { model },
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
      ToggledAssigneeFilter: ({ value }) => ({
        model: {
          ...model,
          filters: {
            ...model.filters,
            assignees: toggleFilter(model.filters.assignees, value),
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
      EditedText: ({ id, field, value }) => {
        const creation = model.creation;
        if (creation?.draft.id === id)
          return creationFieldsLocked(model)
            ? { model }
            : {
                model: {
                  ...model,
                  creation: {
                    ...creation,
                    draft: { ...creation.draft, [field]: value },
                    titleEdited: creation.titleEdited || field === "title",
                  },
                },
              };
        const task = findTask(model, id);
        if (!task) return { model };
        const draft = model.edits[id] ?? Edits.init(task);
        const valid =
          field === "title"
            ? !!value.trim()
            : value.length <= taskDescriptionLimit;
        const timer = valid ? crypto.randomUUID() : null;
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
        return { model: next };
      },
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
            ? { outMessage: OutMessage.OpenList({ mode: "replace" }) }
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
        const creation = model.creation;
        if (creation?.draft.id !== task.id) return { model: next };
        const images = taskImageIds(creation.draft.description, task.id);
        const screenshots = creation.screenshots.filter(({ id }) =>
          images.has(id),
        );
        return uploadDraftScreenshots(next, {
          ...creation,
          saved: true,
          screenshots,
        });
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
        const creation = model.creation;
        if (creation?.draft.id === operation.id) {
          const picker = next.picker;
          const tagIds = creation.draft.tagIds;
          return {
            model: {
              ...next,
              creation: {
                ...creation,
                draft: {
                  ...creation.draft,
                  tagIds:
                    tagIds.includes(tag.id) || tagIds.length >= taskTagLimit
                      ? tagIds
                      : [...tagIds, tag.id],
                },
              },
              picker:
                picker?.id === operation.id &&
                picker.field === "tagIds" &&
                picker.search.inputValue.trim() === operation.input.name
                  ? {
                      ...picker,
                      search: {
                        ...picker.search,
                        inputValue: "",
                        maybeActiveItemIndex: Option.none(),
                      },
                    }
                  : picker,
            },
          };
        }
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
        return {
          model:
            model.picker?.id === operation.id && model.picker.field === "tagIds"
              ? { ...next, tagPickerError: error }
              : next,
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
    const {
      title,
      description,
      status,
      priority,
      dueOn,
      assignee,
      tagIds,
      revision,
    } = {
      ...task,
      ...draft.pending,
    };
    const input = {
      title,
      description,
      status,
      priority,
      dueOn,
      assignee,
      tagIds,
      revision,
    };
    next = setDraft(next, id, {
      ...draft,
      pending: {},
      flight: { request, patch: draft.pending },
    });
    commands.push(Request({ request, operation: { _tag: "Save", id, input } }));
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
    const picker = before.picker;
    if (picker?.surface === "row" && !isVisible(picker.id))
      result = { ...result, model: { ...before, picker: null } };
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
