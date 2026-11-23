import { Effect, Schema } from "effect";
import { Command, Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { trashApiPath, MailMessageId } from "./inbox-contract.ts";

// Shared by Trash's Restore action and notification Undo.
export const Model = Schema.Struct({
  restoring: Schema.NullOr(MailMessageId),
  subject: Schema.optional(Schema.String),
  request: Schema.NullOr(Schema.String),
});
type Model = typeof Model.Type;
export const initial: Model = {
  restoring: null,
  request: null,
};
export const Message = defineMessageUnion({
  Restore: { id: MailMessageId, subject: Schema.optional(Schema.String) },
  Restored: { request: Schema.String, id: MailMessageId },
  Failed: { request: Schema.String },
  SessionExpired: { request: Schema.String },
});
type Message = typeof Message.Type;
const Restore = Command.define("RestoreDeletedMail", {
  args: { request: Schema.String, id: MailMessageId },
  messages: [Message.Restored, Message.Failed, Message.SessionExpired],
  execute: ({ request, id }) =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(`${trashApiPath}/${id}/restore`, {
        method: "POST",
        headers: { "x-effect-auth-csrf": "1" },
        signal,
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      return response.ok
        ? Message.Restored({ request, id })
        : Message.Failed({ request });
    }).pipe(Effect.catch(() => Effect.succeed(Message.Failed({ request })))),
});
export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    Restore: ({ id, subject }) => {
      if (model.request) return { model };
      const request = crypto.randomUUID();
      return {
        model: { ...model, request, restoring: id, subject },
        commands: [Restore({ request, id })],
      };
    },
    Restored: ({ request, id }) => ({
      model:
        model.request === request && model.restoring === id ? initial : model,
    }),
    Failed: ({ request }) => ({
      model: model.request === request ? initial : model,
    }),
    SessionExpired: () => ({ model }),
  });
