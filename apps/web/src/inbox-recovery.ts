import { Effect, Schema } from "effect";
import { Command, Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { trashApiPath, MailMessageId } from "./inbox-contract.ts";

// Shared by Trash's Restore action and the transient Undo after deletion.
export const Model = Schema.Struct({
  lastDeleted: Schema.NullOr(MailMessageId),
  restoring: Schema.NullOr(MailMessageId),
  request: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
type Model = typeof Model.Type;
export const initial: Model = {
  lastDeleted: null,
  restoring: null,
  request: null,
  error: null,
};
export const Message = defineMessageUnion({
  Restore: { id: MailMessageId },
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
    Restore: ({ id }) => {
      if (model.request) return { model };
      const request = crypto.randomUUID();
      return {
        model: { ...model, request, restoring: id, error: null },
        commands: [Restore({ request, id })],
      };
    },
    Restored: ({ request, id }) => ({
      model:
        model.request === request
          ? {
              ...initial,
              lastDeleted: model.lastDeleted === id ? null : model.lastDeleted,
            }
          : model,
    }),
    Failed: ({ request }) => ({
      model:
        model.request === request
          ? {
              ...model,
              request: null,
              restoring: null,
              error: "Could not restore this message. Try again.",
            }
          : model,
    }),
    SessionExpired: () => ({ model }),
  });
