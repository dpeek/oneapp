import {
  DropdownMenu,
  MultiCombobox,
  Popover,
  Sheet,
  Tokenizer,
} from "@orumai/ui";
import { Effect, Option, Schema } from "effect";
import { Command, Update } from "foldkit";
import { focus } from "foldkit/dom";
import { defineMessageUnion } from "foldkit/message";
import { ItemId, Tag, TagCreate, tagsApi } from "./items-contract.ts";
import { createTagPrefix, searchTags } from "./tag-picker.ts";
import * as Attachments from "./task-attachments.ts";
import {
  defaultTaskStatus,
  Task,
  taskApi,
  TaskCreate,
  TaskIndex,
  TaskPriority,
  TaskRoute,
  TaskStatus,
  TaskUpdate,
  tasksApi,
  taskTagLimit,
} from "./tasks-contract.ts";
import {
  defaultFilters,
  emptyFilters,
  Filters,
  toggleFilter,
} from "./tasks-filters.ts";

const Draft = Schema.Struct({
  ...TaskUpdate.fields,
  id: ItemId,
  revision: Schema.NullOr(ItemId),
  title: Schema.String,
  dueOn: Schema.NullOr(Schema.String),
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
  Schema.TaggedStruct("Save", { id: ItemId, input: TaskUpdate }),
  Schema.TaggedStruct("AddTag", { id: ItemId, input: TagCreate }),
]);
type Operation = typeof Operation.Type;
export const FilterCategory = Schema.Literals(["status", "priority", "tags"]);
export const filterOptionsId = "task-filter-options";
export const creationDialogId = "task-create-dialog";
export const creationTitleId = "task-create-title-input";
export const creationSubmitId = "task-create-submit";
const filterPopover = Popover.init({ id: "task-filters" });
const filterTags = MultiCombobox.init("task-filter-tags");
const closedFilterOptions = { filterCategory: null, filterTags };
const Sort = Schema.Literals(["updated", "priority", "due"]);
const sortMenu = DropdownMenu.SingleSelect.init({ id: "task-sort" });
const closedTaskMenus = { filterPopover, ...closedFilterOptions, sortMenu };
export const taskSortMenu =
  DropdownMenu.SingleSelect.create<typeof Sort.Type>();
const Field = Schema.Literals([
  "title",
  "description",
  "status",
  "priority",
  "dueOn",
]);

export const Model = Schema.Struct({
  index: Schema.NullOr(TaskIndex),
  folderSheet: Sheet.Model,
  selectedId: Schema.NullOr(ItemId),
  editor: Schema.NullOr(Editor),
  attachments: Attachments.Model,
  creation: Schema.NullOr(Creation),
  filterPopover: Popover.Model,
  filterCategory: Schema.NullOr(FilterCategory),
  filterTags: MultiCombobox.Model,
  filters: Filters,
  sort: Sort,
  sortMenu: DropdownMenu.SingleSelect.Model,
  request: Schema.NullOr(
    Schema.Struct({ id: Schema.String, operation: Operation }),
  ),
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
  editor: null,
  attachments: Attachments.initial,
  creation: null,
  ...closedTaskMenus,
  filters: defaultFilters,
  sort: "updated",
  request: null,
  error: null,
};

export const Message = defineMessageUnion({
  Opened: { ...TaskRoute.fields, refresh: Schema.Boolean },
  GotFolderSheetMessage: { message: Sheet.Message },
  GotAttachmentsMessage: { message: Attachments.Message },
  FocusUpdated: {},
  Retried: {},
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
  GotTagPickerMessage: { id: ItemId, message: Tokenizer.Message },
  RemovedTag: { id: ItemId },
  Saved: {},
  Discarded: {},
  Loaded: { request: Schema.String, index: TaskIndex },
  TaskCreated: { request: Schema.String, task: Task },
  TaskSaved: { request: Schema.String, task: Task, conflict: Schema.Boolean },
  TagCreated: { request: Schema.String, tag: Tag },
  Failed: { request: Schema.String, error: Schema.String },
  SessionExpired: { request: Schema.String },
});
export type Message = typeof Message.Type;
export const OutMessage = defineMessageUnion({
  OpenTask: { id: ItemId },
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
    Message.TagCreated,
    Message.Failed,
    Message.SessionExpired,
  ],
  execute: ({ request, operation }) =>
    Effect.tryPromise(async (signal) => {
      switch (operation._tag) {
        case "Load": {
          const result = await requestJson(signal, TaskIndex, tasksApi);
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
              AddTag: "Could not add the tag. Try again.",
            }[operation._tag],
          }),
        ),
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
      error: isCreationWrite(model, operation) ? model.error : null,
    },
    commands: [Request({ request: id, operation })],
  };
};

export const selectedTask = (model: Model) =>
  model.index?.tasks.find((task) => task.id === model.selectedId) ?? null;

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
  tagIds,
}: Task) => ({
  id,
  revision,
  title,
  description,
  status,
  priority,
  dueOn,
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
    : { ...model, editor };

export const hasEdits = (draft: Draft, task: Task) =>
  draft.title !== task.title ||
  draft.description !== task.description ||
  draft.status !== task.status ||
  draft.priority !== task.priority ||
  draft.dueOn !== task.dueOn ||
  draft.tagIds.length !== task.tagIds.length ||
  draft.tagIds.some((id) => !task.tagIds.includes(id));

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
    default:
      return { ...draft, [field]: value };
  }
};

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
  request: null,
});

export const update = (
  model: Model,
  message: Message,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> => {
  if ("request" in message && message.request !== model.request?.id)
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
                editor: null,
                attachments: Attachments.initial,
                creation: null,
                error: null,
              }
            : refresh
              ? {
                  ...model,
                  ...closedTaskMenus,
                  ...(model.creation ? { creation: null, error: null } : {}),
                }
              : model;
        const task = selectedTask(next);
        const opened =
          task && next.editor === null
            ? { ...next, editor: makeEditor(toDraft(task)) }
            : next;
        const result =
          refresh || !opened.index
            ? start(opened, { _tag: "Load" })
            : { model: opened };
        return !refresh && id === null && model.selectedId
          ? {
              ...result,
              commands: [
                ...(result.commands ?? []),
                FocusList({ id: model.selectedId }),
              ],
            }
          : result;
      },
      GotFolderSheetMessage: ({ message }) => foldFolderSheet(model, message),
      GotAttachmentsMessage: ({ message }) =>
        (message._tag === "Opened" || message._tag === "Picked") &&
        message.taskId !== model.selectedId
          ? { model }
          : foldAttachments(model, message),
      FocusUpdated: () => ({ model }),
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
          (!preserveView && (model.request || !model.index))
        )
          return { model };
        const next = {
          ...model,
          creation: {
            ...makeEditor({
              id: crypto.randomUUID(),
              revision: null,
              title: "",
              description: "",
              status: defaultTaskStatus,
              priority: null,
              dueOn: null,
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
        const editor = model.creation ?? model.editor;
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
      GotTagPickerMessage: ({ id, message }) => {
        const editor =
          model.creation?.draft.id === id ? model.creation : model.editor;
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
        const editor = model.creation ?? model.editor;
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
      Saved: () => {
        const draft = model.editor?.draft;
        if (!draft || model.creation) return { model };
        const task = selectedTask(model);
        if (!task || draft.revision !== task.revision) return { model };
        const { id, ...fields } = draft;
        const input = { ...fields, title: fields.title.trim() };
        if (!Schema.is(TaskUpdate)(input))
          return {
            model: {
              ...model,
              error: {
                message: "Check the task title, due date and other fields.",
                announcedInCreation: false,
              },
            },
          };
        return start(model, { _tag: "Save", id, input });
      },
      Discarded: () => {
        const task = selectedTask(model);
        return {
          model: {
            ...model,
            editor: task && makeEditor(toDraft(task)),
            error: null,
          },
        };
      },
      Loaded: ({ index }) => {
        const next = { ...model, index, request: null };
        const task = selectedTask(next);
        const previous = selectedTask(model);
        const availableTags = new Set(index.tags.map(({ id }) => id));
        const editor = model.editor;
        return {
          model: {
            ...next,
            filters: {
              ...model.filters,
              tagIds: model.filters.tagIds.filter((id) =>
                availableTags.has(id),
              ),
            },
            editor:
              previous && editor && hasEdits(editor.draft, previous)
                ? {
                    ...editor,
                    draft: {
                      ...editor.draft,
                      tagIds: editor.draft.tagIds.filter((id) =>
                        availableTags.has(id),
                      ),
                    },
                  }
                : task && makeEditor(toDraft(task)),
          },
        };
      },
      TaskCreated: ({ task }) => {
        const next = replaceTask(model, task);
        if (model.creation?.draft.id !== task.id) return { model: next };
        return {
          model: { ...next, creation: null },
          ...(!model.creation.preserveView && model.selectedId === null
            ? { outMessage: OutMessage.OpenTask({ id: task.id }) }
            : {}),
        };
      },
      TaskSaved: ({ task, conflict }) => {
        const next = replaceTask(model, task);
        if (task.id !== model.selectedId)
          return {
            model: {
              ...next,
              error: conflict
                ? {
                    message: "The task changed. Try again.",
                    announcedInCreation: false,
                  }
                : null,
            },
          };
        return {
          model: {
            ...next,
            editor:
              conflict || !model.editor
                ? model.editor
                : { ...model.editor, draft: toDraft(task) },
            error: conflict
              ? {
                  message:
                    "This task changed elsewhere. Reload the saved task before editing again.",
                  announcedInCreation: false,
                }
              : null,
          },
        };
      },
      TagCreated: ({ tag }) => {
        const tags = model.index?.tags;
        const newTags = tags?.some(({ id }) => id === tag.id)
          ? tags
          : [...(tags ?? []), tag];
        const operation = model.request?.operation;
        const editor =
          operation?._tag === "AddTag" &&
          model.creation?.draft.id === operation.id
            ? model.creation
            : model.editor;
        const next = {
          ...model,
          index: model.index && { ...model.index, tags: newTags },
          request: null,
        };
        return {
          model:
            editor &&
            operation?._tag === "AddTag" &&
            editor.draft.id === operation.id
              ? withEditor(
                  next,
                  afterTagSelection(editor, attach(editor.draft, tag.id)),
                )
              : next,
        };
      },
      Failed: ({ error }) => {
        const operation = model.request?.operation;
        const next = { ...model, request: null };
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
        const editor =
          model.creation?.draft.id === operation.id
            ? model.creation
            : model.editor;
        if (editor?.draft.id !== operation.id) return { model: next };
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
