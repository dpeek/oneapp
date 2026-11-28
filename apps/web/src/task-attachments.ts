import { Effect, Schema } from "effect";
import { Command, Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { detectFilePreviewType } from "./file-preview-type.ts";
import { FileName, fileNameHeader } from "./files-contract.ts";
import { ItemId } from "./items-contract.ts";
import {
  InlineImagePaste,
  InlineImageUploads,
} from "./markdown-editor-contract.ts";
import {
  TaskAttachment,
  TaskAttachmentMediaType,
  taskAttachmentIdHeader,
  taskAttachmentLimit,
  taskAttachmentLimitMiB,
  taskAttachmentsApi,
  taskInlineImageHeader,
} from "./task-attachment-contract.ts";

export const StagedScreenshot = Schema.Struct({
  ...InlineImagePaste.fields,
  name: FileName,
  error: Schema.NullOr(Schema.String),
});

export const Model = Schema.Struct({
  taskId: Schema.NullOr(ItemId),
  pending: Schema.Array(ItemId),
  inlineImageUploads: InlineImageUploads,
});
type Model = typeof Model.Type;

export const initial: Model = {
  taskId: null,
  pending: [],
  inlineImageUploads: {},
};

export const Message = defineMessageUnion({
  Picked: { taskId: ItemId, ...InlineImagePaste.fields },
  Uploaded: { request: ItemId },
  Failed: { request: ItemId, error: Schema.String },
  SessionExpired: { request: ItemId },
  Validated: {
    draftId: ItemId,
    id: ItemId,
    screenshot: Schema.NullOr(StagedScreenshot),
    error: Schema.NullOr(Schema.String),
  },
});
type Message = typeof Message.Type;
const OutMessage = defineMessageUnion({ SessionExpired: {} });
type OutMessage = typeof OutMessage.Type;

const invalidImage = `Choose a PNG or JPEG image up to ${taskAttachmentLimitMiB} MiB.`;
const uploadFailed = "Could not upload the image. Try inserting it again.";

const imageName = (file: File) =>
  file.name || (file.type === "image/jpeg" ? "Image.jpg" : "Image.png");

const fileError = (file: File, name: string) =>
  file.size === 0 || file.size > taskAttachmentLimit
    ? invalidImage
    : !Schema.is(FileName)(name)
      ? "Rename the image and try again."
      : null;

export const ValidateDraftScreenshot = Command.define(
  "ValidateDraftTaskImage",
  {
    args: { draftId: ItemId, ...InlineImagePaste.fields },
    messages: [Message.Validated],
    execute: ({ draftId, id, file }) =>
      Effect.promise(async () => {
        const name = imageName(file);
        let error = fileError(file, name);
        if (!error) {
          try {
            const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
            if (
              !Schema.is(TaskAttachmentMediaType)(detectFilePreviewType(bytes))
            )
              error = invalidImage;
          } catch {
            error = "Could not read the image. Try inserting it again.";
          }
        }
        return Message.Validated({
          draftId,
          id,
          screenshot: error ? null : { id, name, file, error: null },
          error,
        });
      }),
  },
);

const readFailure = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.String }),
);

export const Run = Command.define("UploadTaskImage", {
  args: { taskId: ItemId, ...InlineImagePaste.fields, name: FileName },
  messages: [Message.Uploaded, Message.Failed, Message.SessionExpired],
  execute: ({ taskId, id, file, name }) => {
    const fail = (error: string) => Message.Failed({ request: id, error });
    return Effect.tryPromise(async (signal) => {
      const response = await fetch(taskAttachmentsApi(taskId), {
        method: "POST",
        cache: "no-store",
        signal,
        headers: {
          [fileNameHeader]: encodeURIComponent(name),
          [taskAttachmentIdHeader]: id,
          [taskInlineImageHeader]: "1",
          "x-effect-auth-csrf": "1",
        },
        body: file,
      });
      if (response.status === 401)
        return Message.SessionExpired({ request: id });
      if (!response.ok) {
        const problem = readFailure(await response.json());
        return fail(
          problem._tag === "Some" ? problem.value.error : uploadFailed,
        );
      }
      const attachment = Schema.decodeUnknownSync(TaskAttachment)(
        await response.json(),
      );
      return attachment.id === id
        ? Message.Uploaded({ request: id })
        : fail(uploadFailed);
    }).pipe(Effect.catch(() => Effect.succeed(fail(uploadFailed))));
  },
});

const settle = (model: Model, id: string, outcome: true | string): Model => ({
  ...model,
  pending: model.pending.filter((pending) => pending !== id),
  inlineImageUploads: { ...model.inlineImageUploads, [id]: outcome },
});

export const update = (
  model: Model,
  message: Message,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> => {
  if ("request" in message && !model.pending.includes(message.request))
    return { model };
  return Message.match(message, {
    Picked: ({ taskId, id, file }) => {
      const current = model.taskId === taskId ? model : { ...initial, taskId };
      const name = imageName(file);
      const error = fileError(file, name);
      return error
        ? { model: settle(current, id, error) }
        : {
            model: { ...current, pending: [...current.pending, id] },
            commands: [Run({ taskId, id, file, name })],
          };
    },
    Uploaded: ({ request }) => ({ model: settle(model, request, true) }),
    Failed: ({ request, error }) => ({ model: settle(model, request, error) }),
    SessionExpired: ({ request }) => ({
      model: settle(model, request, uploadFailed),
      outMessage: OutMessage.SessionExpired(),
    }),
    Validated: () => ({ model }),
  });
};
