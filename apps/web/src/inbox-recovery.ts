import { mailFetch } from "./mailbox-client.ts";
import { Effect, Schema } from "effect";
import { Command, Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import {
  MailMessageId,
  trashApiPath,
  TrashBatchId,
  TrashBatchMembers,
  trashBatchRestoreApi,
} from "./inbox-contract.ts";

// Shared by Trash's Restore action and notification Undo.
export const Model = Schema.Struct({
  restoring: Schema.NullOr(MailMessageId),
  subject: Schema.optional(Schema.String),
  batchId: Schema.optionalKey(TrashBatchId),
  request: Schema.NullOr(Schema.String),
});
type Model = typeof Model.Type;
export const initial: Model = {
  restoring: null,
  request: null,
};
export const Message = defineMessageUnion({
  Restore: {
    id: MailMessageId,
    subject: Schema.optional(Schema.String),
    batchId: Schema.optionalKey(TrashBatchId),
  },
  Restored: {
    request: Schema.String,
    id: MailMessageId,
    members: Schema.optionalKey(TrashBatchMembers),
  },
  Failed: { request: Schema.String },
  SessionExpired: { request: Schema.String },
});
type Message = typeof Message.Type;
const Restore = Command.define("RestoreDeletedMail", {
  args: {
    request: Schema.String,
    id: MailMessageId,
    batchId: Schema.optionalKey(TrashBatchId),
  },
  messages: [Message.Restored, Message.Failed, Message.SessionExpired],
  execute: ({ request, id, batchId }) =>
    Effect.tryPromise(async (signal) => {
      const path = batchId
        ? trashBatchRestoreApi(batchId)
        : `${trashApiPath}/${id}/restore`;
      const response = await mailFetch(path, {
        method: "POST",
        headers: { "x-effect-auth-csrf": "1" },
        signal,
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      if (!response.ok) return Message.Failed({ request });
      if (!batchId) return Message.Restored({ request, id });
      const members = Schema.decodeUnknownSync(TrashBatchMembers)(
        await response.json(),
      );
      return Message.Restored({ request, id, members });
    }).pipe(Effect.catch(() => Effect.succeed(Message.Failed({ request })))),
});
export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    Restore: ({ id, subject, batchId }) => {
      if (model.request) return { model };
      const request = crypto.randomUUID();
      const batch = batchId ? { batchId } : {};
      return {
        model: { ...model, request, restoring: id, subject, ...batch },
        commands: [Restore({ request, id, ...batch })],
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
