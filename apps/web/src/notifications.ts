import { Toast } from "@orumai/ui";
import { Schema } from "effect";
import { Command, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { MailMessageId, TrashBatchId } from "./inbox-contract.ts";
import { PersonId } from "./people-contract.ts";

export const ContactUndo = Schema.Struct({
  id: PersonId,
  receipt: PersonId,
  name: Schema.String,
});
export const Action = defineMessageUnion({
  RestoreMail: {
    id: MailMessageId,
    subject: Schema.optional(Schema.String),
    batchId: Schema.optionalKey(TrashBatchId),
  },
  RestoreContact: ContactUndo.fields,
});
export type Action = typeof Action.Type;

// Features report accepted outcomes, without depending on the toast renderer.
export const Notification = Schema.Struct({
  key: Schema.String,
  variant: Toast.Variant,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  durationMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  action: Schema.optional(Action),
});
export type Notification = typeof Notification.Type;

export const Model = Schema.Struct({
  generation: Schema.Int,
  toast: Toast.Model,
  keys: Schema.Record(Schema.String, Schema.String),
  actions: Schema.Record(Schema.String, Action),
});
export type Model = typeof Model.Type;
export const init = (generation = 0): Model => ({
  generation,
  toast: Toast.init({ id: `notifications-${generation}` }),
  keys: {},
  actions: {},
});

// Changing the generation makes commands from a previous account harmless.
export const clear = (model: Model): Model => init(model.generation + 1);
export const Message = defineMessageUnion({
  GotToast: { generation: Schema.Int, message: Toast.Message },
  HostMounted: {},
});
export type Message = typeof Message.Type;
export const wrap = (generation: number) => (message: Toast.Message) =>
  Message.GotToast({ generation, message });

export const show = (
  model: Model,
  notification: Notification,
): Update.Return<Model, Message> => {
  const id = model.keys[notification.key];
  const existing = model.toast.entries.find(
    (entry) =>
      entry.id === id && !entry.animation.transitionState.startsWith("Leave"),
  );
  const input = {
    ...notification,
    ...(notification.action ? { actionLabel: "Undo" } : {}),
    ...(notification.durationMs === undefined
      ? {}
      : { sticky: false, duration: notification.durationMs }),
  };
  // Replacing an actionable outcome must also remove its old action and details.
  const replace =
    existing &&
    (Boolean(existing.payload.actionLabel) !== Boolean(notification.action) ||
      (existing.payload.description !== undefined &&
        notification.description === undefined));
  const dismissed = replace
    ? Toast.dismiss(model.toast, existing.id)
    : { model: model.toast, commands: [] };
  const result =
    existing && !replace
      ? Toast.updateToast(model.toast, existing.id, input)
      : Toast.show(dismissed.model, input);
  const entryId =
    existing && !replace ? existing.id : result.model.entries.at(-1)!.id;
  const actions = { ...model.actions };
  if (existing) delete actions[existing.id];
  if (notification.action) actions[entryId] = notification.action;
  return {
    model: {
      ...model,
      toast: result.model,
      keys: { ...model.keys, [notification.key]: entryId },
      actions,
    },
    commands: Command.mapMessages(
      [...(dismissed.commands ?? []), ...(result.commands ?? [])],
      wrap(model.generation),
    ),
  };
};

// Successful visible changes silently retire any earlier failure or Undo.
export const dismiss = (
  model: Model,
  key: string,
): Update.Return<Model, Message> => {
  const id = model.keys[key];
  if (id === undefined) return { model };
  const result = Toast.dismiss(model.toast, id);
  const keys = { ...model.keys };
  const actions = { ...model.actions };
  delete keys[key];
  delete actions[id];
  return {
    model: { ...model, toast: result.model, keys, actions },
    commands: Command.mapMessages(
      result.commands ?? [],
      wrap(model.generation),
    ),
  };
};

export const update = (
  model: Model,
  message: Message,
): Update.ReturnWithOutMessage<Model, Message, Action> => {
  if (message._tag === "HostMounted" || message.generation !== model.generation)
    return { model };
  const result = Toast.update(model.toast, message.message);
  const ids = new Set(
    result.model.entries
      .filter((entry) => !entry.animation.transitionState.startsWith("Leave"))
      .map((entry) => entry.id),
  );
  const action =
    result.outMessage?._tag === "ActivatedToast"
      ? model.actions[result.outMessage.entry.id]
      : undefined;
  return {
    model: {
      ...model,
      toast: result.model,
      actions: Object.fromEntries(
        Object.entries(model.actions).filter(([id]) => ids.has(id)),
      ),
      keys: Object.fromEntries(
        Object.entries(model.keys).filter(([, id]) => ids.has(id)),
      ),
    },
    ...(action ? { outMessage: action } : {}),
    commands: Command.mapMessages(
      result.commands ?? [],
      wrap(model.generation),
    ),
  };
};
