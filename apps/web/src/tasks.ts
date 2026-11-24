import { Tokenizer } from "@oneapp/ui";
import { Effect, Option, Schema } from "effect";
import { Command, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import {
  ItemId,
  normalizeTagName,
  Tag,
  TagCreate,
  TagName,
  tagNameKey,
  tagsApi,
  tagNameLimit,
} from "./items-contract.ts";
import {
  Task,
  taskApi,
  TaskCreate,
  TaskIndex,
  TaskPriority,
  TaskStatus,
  TaskTitle,
  TaskUpdate,
  tasksApi,
  taskTagLimit,
} from "./tasks-contract.ts";

const Draft = Schema.Struct({
  ...TaskUpdate.fields,
  id: ItemId,
  title: Schema.String,
  dueOn: Schema.NullOr(Schema.String),
});
type Draft = typeof Draft.Type;
const Operation = Schema.Union([
  Schema.TaggedStruct("Load", {}),
  Schema.TaggedStruct("Create", { input: TaskCreate }),
  Schema.TaggedStruct("Save", { id: ItemId, input: TaskUpdate }),
  Schema.TaggedStruct("AddTag", { id: ItemId, input: TagCreate }),
]);
type Operation = typeof Operation.Type;
const StatusFilter = Schema.Union([
  Schema.Literals(["active", "all"]),
  TaskStatus,
]);
const Sort = Schema.Literals(["updated", "priority", "due"]);
const Field = Schema.Literals([
  "title",
  "description",
  "status",
  "priority",
  "dueOn",
]);

export const Model = Schema.Struct({
  index: Schema.NullOr(TaskIndex),
  selectedId: Schema.NullOr(ItemId),
  draft: Schema.NullOr(Draft),
  quickTitle: Schema.String,
  quickId: Schema.NullOr(ItemId),
  tagPicker: Tokenizer.Model,
  tagError: Schema.NullOr(Schema.String),
  statusFilter: StatusFilter,
  tagFilter: Schema.NullOr(ItemId),
  sort: Sort,
  request: Schema.NullOr(
    Schema.Struct({ id: Schema.String, operation: Operation }),
  ),
  error: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;
export const initial: Model = {
  index: null,
  selectedId: null,
  draft: null,
  quickTitle: "",
  quickId: null,
  tagPicker: Tokenizer.init({ id: "task-tags" }),
  tagError: null,
  statusFilter: "active",
  tagFilter: null,
  sort: "updated",
  request: null,
  error: null,
};

export const Message = defineMessageUnion({
  Opened: { id: Schema.NullOr(ItemId), refresh: Schema.Boolean },
  Retried: {},
  EditedQuickTitle: { title: Schema.String },
  Created: {},
  EditedField: { field: Field, value: Schema.String },
  ToggledCompletion: { id: ItemId },
  SetStatusFilter: { value: Schema.String },
  SetTagFilter: { value: Schema.String },
  SetSort: { value: Schema.String },
  GotTagPickerMessage: { message: Tokenizer.Message },
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

const start = (
  model: Model,
  operation: Operation,
): Update.Return<Model, Message> => {
  if (model.request) return { model };
  const id = crypto.randomUUID();
  return {
    model: { ...model, request: { id, operation }, error: null },
    commands: [Request({ request: id, operation })],
  };
};

export const selectedTask = (model: Model) =>
  model.index?.tasks.find((task) => task.id === model.selectedId) ?? null;

const toDraft = ({
  id,
  revision,
  title,
  description,
  status,
  priority,
  dueOn,
  tagIds,
}: Task): Draft => ({
  id,
  revision,
  title,
  description,
  status,
  priority,
  dueOn,
  tagIds,
});

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
    case "status": {
      const status = value || null;
      return Schema.is(TaskStatus)(status) ? { ...draft, status } : draft;
    }
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

const createTagPrefix = "create:";

export const tagSearch = (model: Model, tags = model.index?.tags ?? []) => {
  const name = normalizeTagName(model.tagPicker.inputValue);
  const key = tagNameKey(name);
  const matches = tags.filter((tag) => tagNameKey(tag.name).includes(key));
  const items = matches.filter((tag) => !model.draft?.tagIds.includes(tag.id));
  const invalid = name !== "" && !Schema.is(TagName)(name);
  const canCreate =
    name !== "" &&
    !invalid &&
    !matches.some((tag) => tagNameKey(tag.name) === key);
  return {
    name,
    canCreate,
    items: canCreate
      ? [
          ...items,
          { id: `${createTagPrefix}${name}`, name: `Create “${name}”` },
        ]
      : items,
    error: invalid
      ? `Enter a tag name of up to ${tagNameLimit} characters.`
      : model.tagError,
  };
};

const toTagPickerMessage = (message: typeof Tokenizer.Message.Type) =>
  Message.GotTagPickerMessage({ message });

const afterTagSelection = (model: Model, draft: Draft): Model => ({
  ...model,
  draft,
  tagError: null,
  tagPicker:
    draft.tagIds.length >= taskTagLimit
      ? Tokenizer.init({ id: model.tagPicker.id })
      : {
          ...model.tagPicker,
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
          id === model.selectedId
            ? model
            : {
                ...model,
                selectedId: id,
                draft: null,
                tagPicker: Tokenizer.init({
                  id: id ? `task-tags-${id}` : "task-tags",
                }),
                tagError: null,
                error: null,
              };
        const task = selectedTask(next);
        const opened =
          task && next.draft === null
            ? { ...next, draft: toDraft(task) }
            : next;
        return refresh || !opened.index
          ? start(opened, { _tag: "Load" })
          : { model: opened };
      },
      Retried: () => start(model, { _tag: "Load" }),
      EditedQuickTitle: ({ title }) => ({
        model: { ...model, quickTitle: title, quickId: null },
      }),
      Created: () => {
        if (model.request || !model.index) return { model };
        const title = model.quickTitle.trim();
        if (!Schema.is(TaskTitle)(title))
          return { model: { ...model, error: "Enter a task title." } };
        const id = model.quickId ?? crypto.randomUUID();
        return start(
          { ...model, quickId: id },
          { _tag: "Create", input: { id, title } },
        );
      },
      EditedField: ({ field, value }) => ({
        model:
          model.draft && !model.request
            ? { ...model, draft: editField(model.draft, field, value) }
            : model,
      }),
      ToggledCompletion: ({ id }) => {
        const task = model.index?.tasks.find((entry) => entry.id === id);
        if (!task || (model.draft?.id === id && hasEdits(model.draft, task)))
          return { model };
        const { id: itemId, ...input } = toDraft(task);
        return start(model, {
          _tag: "Save",
          id: itemId,
          input: {
            ...input,
            status: task.status === "completed" ? "not-started" : "completed",
          },
        });
      },
      SetStatusFilter: ({ value }) => {
        const statusFilter = value || null;
        return {
          model: Schema.is(StatusFilter)(statusFilter)
            ? { ...model, statusFilter }
            : model,
        };
      },
      SetTagFilter: ({ value }) => ({
        model: { ...model, tagFilter: Schema.is(ItemId)(value) ? value : null },
      }),
      SetSort: ({ value }) => ({
        model: Schema.is(Sort)(value) ? { ...model, sort: value } : model,
      }),
      GotTagPickerMessage: ({ message }) => {
        const draft = model.draft;
        if (!draft || draft.tagIds.length >= taskTagLimit) return { model };
        const result = Tokenizer.update(model.tagPicker, message);
        const next = {
          ...model,
          tagPicker: result.model,
          tagError:
            message._tag === "UpdatedInputValue" ? null : model.tagError,
        };
        const commands = Command.mapMessages(
          result.commands ?? [],
          toTagPickerMessage,
        );
        const selection = result.outMessage;
        if (model.request || selection?._tag !== "Selected")
          return { model: next, commands };
        if (selection.value.startsWith(createTagPrefix)) {
          const { name, canCreate } = tagSearch(next);
          return canCreate && selection.value === `${createTagPrefix}${name}`
            ? start(next, { _tag: "AddTag", id: draft.id, input: { name } })
            : { model: next, commands };
        }
        return {
          model: model.index?.tags.some((tag) => tag.id === selection.value)
            ? afterTagSelection(next, attach(draft, selection.value))
            : next,
          commands,
        };
      },
      RemovedTag: ({ id }) => {
        if (!model.draft || model.request) return { model };
        return {
          model: {
            ...model,
            draft: {
              ...model.draft,
              tagIds: model.draft.tagIds.filter((tagId) => tagId !== id),
            },
          },
          commands: Command.mapMessages(
            [Tokenizer.FocusInput({ id: model.tagPicker.id })],
            toTagPickerMessage,
          ),
        };
      },
      Saved: () => {
        if (!model.draft) return { model };
        const task = selectedTask(model);
        if (!task || model.draft.revision !== task.revision) return { model };
        const { id, ...fields } = model.draft;
        const input = { ...fields, title: fields.title.trim() };
        if (!Schema.is(TaskUpdate)(input))
          return {
            model: {
              ...model,
              error: "Check the task title, due date and other fields.",
            },
          };
        return start(model, { _tag: "Save", id, input });
      },
      Discarded: () => {
        const task = selectedTask(model);
        return {
          model: {
            ...model,
            draft: task && toDraft(task),
            tagPicker: Tokenizer.init({ id: model.tagPicker.id }),
            tagError: null,
            error: null,
          },
        };
      },
      Loaded: ({ index }) => {
        const next = { ...model, index, request: null };
        const task = selectedTask(next);
        const previous = selectedTask(model);
        return {
          model: {
            ...next,
            draft:
              previous && model.draft && hasEdits(model.draft, previous)
                ? model.draft
                : task && toDraft(task),
          },
        };
      },
      TaskCreated: ({ task }) => ({
        model: { ...replaceTask(model, task), quickTitle: "", quickId: null },
        ...(model.selectedId === null
          ? { outMessage: OutMessage.OpenTask({ id: task.id }) }
          : {}),
      }),
      TaskSaved: ({ task, conflict }) => {
        const next = replaceTask(model, task);
        if (task.id !== model.selectedId)
          return {
            model: {
              ...next,
              error: conflict ? "The task changed. Try again." : null,
            },
          };
        return {
          model: {
            ...next,
            draft: conflict ? model.draft : toDraft(task),
            error: conflict
              ? "This task changed elsewhere. Reload the saved task before editing again."
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
        const draft = model.draft;
        const next = {
          ...model,
          index: model.index && { ...model.index, tags: newTags },
          request: null,
        };
        return {
          model:
            draft && operation?._tag === "AddTag" && draft.id === operation.id
              ? afterTagSelection(next, attach(draft, tag.id))
              : next,
        };
      },
      Failed: ({ error }) => {
        const operation = model.request?.operation;
        const next = { ...model, request: null };
        if (operation?._tag !== "AddTag") return { model: { ...next, error } };
        if (model.draft?.id !== operation.id) return { model: next };
        return {
          model: {
            ...next,
            tagError: error,
            tagPicker: {
              ...Tokenizer.init({ id: model.tagPicker.id }),
              inputValue: operation.input.name,
            },
          },
        };
      },
      SessionExpired: () => ({
        model,
        outMessage: OutMessage.SessionExpired(),
      }),
    },
  );
};
