import { Schema } from "effect";
import { ItemId } from "./items-contract.ts";
import {
  type Task,
  TaskFields,
  TaskTitle,
  TaskUpdate,
} from "./tasks-contract.ts";

export const TextField = Schema.Literals(["title", "description"]);
export type TextField = typeof TextField.Type;
export const Patch = Schema.Struct({
  title: Schema.optionalKey(TaskFields.fields.title),
  description: Schema.optionalKey(TaskFields.fields.description),
  status: Schema.optionalKey(TaskFields.fields.status),
  priority: Schema.optionalKey(TaskFields.fields.priority),
  dueOn: Schema.optionalKey(TaskFields.fields.dueOn),
  assignee: TaskUpdate.fields.assignee,
  tagIds: Schema.optionalKey(TaskFields.fields.tagIds),
});
export type Patch = typeof Patch.Type;
const Text = Schema.Struct({
  value: Schema.String,
  timer: Schema.NullOr(Schema.String),
});
export const Draft = Schema.Struct({
  revision: ItemId,
  text: Schema.Struct({
    title: Schema.optionalKey(Text),
    description: Schema.optionalKey(Text),
  }),
  pending: Patch,
  flight: Schema.NullOr(
    Schema.Struct({ request: Schema.String, patch: Patch }),
  ),
  error: Schema.NullOr(Schema.Literals(["failed", "conflict"])),
});
export type Draft = typeof Draft.Type;

export const init = (task: Task): Draft => ({
  revision: task.revision,
  text: {},
  pending: {},
  flight: null,
  error: null,
});

export const overlay = (task: Task, draft: Draft | undefined): Task =>
  draft ? { ...task, ...draft.flight?.patch, ...draft.pending } : task;

export const changed = (patch: Patch) => Object.keys(patch).length !== 0;
export const saving = (draft: Draft | undefined) =>
  !!draft &&
  !draft.error &&
  (!!draft.flight ||
    changed(draft.pending) ||
    Object.values(draft.text).some((text) => text?.timer));

const same = (left: unknown, right: unknown) =>
  Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length &&
      left.every((value) => right.includes(value))
    : left === right;

export const stage = (task: Task, draft: Draft, patch: Patch): Draft => {
  const baseline = { ...task, ...draft.flight?.patch };
  const pending = { ...draft.pending, ...patch };
  for (const field of Object.keys(pending) as (keyof Patch)[]) {
    if (same(pending[field], baseline[field])) delete pending[field];
  }
  return { ...draft, pending };
};

export const commitText = (
  task: Task,
  draft: Draft,
  field: TextField,
  blur: boolean,
): Draft => {
  const input = draft.text[field];
  if (!input) return draft;
  const value = field === "title" ? input.value.trim() : input.value;
  const text = { ...draft.text };
  const valid =
    field === "title"
      ? Schema.is(TaskTitle)(value)
      : Schema.is(TaskFields.fields.description)(value);
  if (!valid) {
    const pending = { ...draft.pending };
    delete pending[field];
    return {
      ...draft,
      pending,
      text: { ...text, [field]: { ...input, timer: null } },
    };
  }
  if (!blur && value !== input.value) text[field] = { ...input, timer: null };
  else delete text[field];
  return stage(task, { ...draft, text }, { [field]: value });
};

export const settled = (
  task: Task,
  draft: Draft,
  error: Draft["error"],
): Draft => {
  const sent = draft.flight?.patch;
  const next = { ...draft, flight: null, error };
  return error
    ? { ...next, pending: { ...sent, ...draft.pending } }
    : stage(task, { ...next, revision: task.revision }, {});
};
