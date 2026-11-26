import { alert, button, buttonClassName, input, spinner } from "@orumai/ui";
import { Effect, Queue, Schema, Stream } from "effect";
import { Command, Mount, Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { fileSize } from "./file-display.ts";
import { FileName, fileNameHeader } from "./files-contract.ts";
import { ItemId } from "./items-contract.ts";
import {
  TaskAttachment,
  TaskAttachments,
  taskAttachmentApi,
  taskAttachmentLimit,
  taskAttachmentLimitMiB,
  taskAttachmentsApi,
} from "./task-attachment-contract.ts";

const UploadFile = Schema.instanceOf(File);
const Operation = Schema.Literals(["Load", "Upload", "Remove"]);

export const Model = Schema.Struct({
  taskId: Schema.NullOr(ItemId),
  attachments: Schema.NullOr(TaskAttachments.fields.attachments),
  request: Schema.NullOr(Schema.Struct({ id: ItemId, operation: Operation })),
  error: Schema.NullOr(Schema.String),
});
type Model = typeof Model.Type;

export const initial: Model = {
  taskId: null,
  attachments: null,
  request: null,
  error: null,
};

export const Message = defineMessageUnion({
  Opened: { taskId: ItemId },
  Picked: { taskId: ItemId, file: UploadFile },
  Removed: { id: ItemId },
  Retried: {},
  Loaded: { request: ItemId, ...TaskAttachments.fields },
  Uploaded: { request: ItemId, attachment: TaskAttachment },
  Deleted: { request: ItemId, id: ItemId },
  Failed: { request: ItemId, error: Schema.String },
  SessionExpired: { request: ItemId },
});
type Message = typeof Message.Type;
const OutMessage = defineMessageUnion({ SessionExpired: {} });
type OutMessage = typeof OutMessage.Type;

export const WatchEditor = Mount.defineStream("WatchTaskScreenshotInput", {
  args: { taskId: ItemId },
  messages: [Message.Opened, Message.Picked],
  execute: ({ element, taskId }) =>
    Stream.callback<typeof Message.Opened.Type | typeof Message.Picked.Type>(
      (queue) => {
        const pick = (file: File) =>
          Queue.offerUnsafe(queue, Message.Picked({ taskId, file }));
        const change = (event: Event) => {
          const target = event.target;
          if (
            !(target instanceof HTMLInputElement) ||
            !target.hasAttribute("data-task-screenshot-picker")
          )
            return;
          const file = target.files?.[0];
          target.value = "";
          if (file) pick(file);
        };
        const paste = (event: Event) => {
          if (!(event instanceof ClipboardEvent)) return;
          const file = event.clipboardData?.files[0];
          if (!file) return;
          event.preventDefault();
          pick(file);
        };
        const detail = element.closest(".task-detail") ?? element;
        return Effect.acquireRelease(
          Effect.sync(() => {
            element.addEventListener("change", change);
            detail.addEventListener("paste", paste);
            Queue.offerUnsafe(queue, Message.Opened({ taskId }));
          }),
          () =>
            Effect.sync(() => {
              element.removeEventListener("change", change);
              detail.removeEventListener("paste", paste);
            }),
        );
      },
    ),
});

const errors = {
  Load: "Could not load screenshots. Try again.",
  Upload: "Could not upload the screenshot. Pick or paste it again.",
  Remove: "Could not remove the screenshot. Try again.",
};
const tooLarge = `Choose a PNG or JPEG up to ${taskAttachmentLimitMiB} MiB.`;
const readFailure = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.String }),
);

const Transfer = Schema.Union([
  Schema.TaggedStruct("Load", {}),
  Schema.TaggedStruct("Upload", { file: UploadFile, name: FileName }),
  Schema.TaggedStruct("Remove", { id: ItemId }),
]);
type Transfer = typeof Transfer.Type;

const Run = Command.define("ManageTaskScreenshots", {
  args: { request: ItemId, taskId: ItemId, transfer: Transfer },
  messages: [
    Message.Loaded,
    Message.Uploaded,
    Message.Deleted,
    Message.Failed,
    Message.SessionExpired,
  ],
  execute: ({ request, taskId, transfer }) => {
    const fail = (error: string) => Message.Failed({ request, error });
    return Effect.tryPromise(async (signal) => {
      const response = await fetch(
        transfer._tag === "Remove"
          ? taskAttachmentApi(taskId, transfer.id)
          : taskAttachmentsApi(taskId),
        {
          cache: "no-store",
          signal,
          ...(transfer._tag === "Upload"
            ? {
                method: "POST",
                headers: {
                  [fileNameHeader]: encodeURIComponent(transfer.name),
                  "x-effect-auth-csrf": "1",
                },
                body: transfer.file,
              }
            : transfer._tag === "Remove"
              ? {
                  method: "DELETE",
                  headers: { "x-effect-auth-csrf": "1" },
                }
              : {}),
        },
      );
      if (response.status === 401) return Message.SessionExpired({ request });
      if (
        transfer._tag === "Remove" &&
        (response.ok || response.status === 404)
      )
        return Message.Deleted({ request, id: transfer.id });
      if (!response.ok) {
        if (
          transfer._tag === "Upload" &&
          [400, 404, 413, 415].includes(response.status)
        ) {
          const error = readFailure(await response.json());
          if (error._tag === "Some") return fail(error.value.error);
        }
        return fail(errors[transfer._tag]);
      }
      const body = await response.json();
      return transfer._tag === "Upload"
        ? Message.Uploaded({
            request,
            attachment: Schema.decodeUnknownSync(TaskAttachment)(body),
          })
        : Message.Loaded({
            request,
            ...Schema.decodeUnknownSync(TaskAttachments)(body),
          });
    }).pipe(Effect.catch(() => Effect.succeed(fail(errors[transfer._tag]))));
  },
});

const start = (
  model: Model,
  transfer: Transfer,
): Update.Return<Model, Message> => {
  if (!model.taskId || model.request) return { model };
  const request = crypto.randomUUID();
  return {
    model: {
      ...model,
      request: { id: request, operation: transfer._tag },
      error: null,
    },
    commands: [Run({ request, taskId: model.taskId, transfer })],
  };
};

export const update = (
  model: Model,
  message: Message,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> => {
  if ("request" in message && message.request !== model.request?.id)
    return { model };
  return Message.match(message, {
    Opened: ({ taskId }) =>
      start(taskId === model.taskId ? model : { ...initial, taskId }, {
        _tag: "Load",
      }),
    Picked: ({ taskId, file }) => {
      if (taskId !== model.taskId) return { model };
      if (model.request)
        return {
          model: {
            ...model,
            error:
              "Wait for the current screenshot operation, then paste it again.",
          },
        };
      const name =
        file.name ||
        (file.type === "image/jpeg" ? "Screenshot.jpg" : "Screenshot.png");
      const error =
        file.size > taskAttachmentLimit
          ? tooLarge
          : !Schema.is(FileName)(name)
            ? "Rename the screenshot and try again."
            : null;
      return error
        ? { model: { ...model, error } }
        : start(model, { _tag: "Upload", file, name });
    },
    Removed: ({ id }) => start(model, { _tag: "Remove", id }),
    Retried: () => start(model, { _tag: "Load" }),
    Loaded: ({ attachments }) => ({
      model: { ...model, request: null, attachments },
    }),
    Uploaded: ({ attachment }) => ({
      model: {
        ...model,
        request: null,
        attachments: [...(model.attachments ?? []), attachment],
      },
    }),
    Deleted: ({ id }) => ({
      model: {
        ...model,
        request: null,
        attachments:
          model.attachments?.filter((attachment) => attachment.id !== id) ??
          null,
      },
    }),
    Failed: ({ error }) => ({ model: { ...model, request: null, error } }),
    SessionExpired: () => ({
      model: { ...model, request: null },
      outMessage: OutMessage.SessionExpired(),
    }),
  });
};

export const section = <ParentMessage>(
  taskId: string,
  state: Model,
  toParent: (message: Message) => ParentMessage,
  h: HtmlBuilder<ParentMessage>,
) => {
  const model = state.taskId === taskId ? state : initial;
  const busy = model.request !== null || model.taskId === null;
  const status =
    model.request?.operation === "Upload"
      ? "Uploading screenshot…"
      : model.request?.operation === "Remove"
        ? "Removing screenshot…"
        : !model.attachments && !model.error
          ? "Loading screenshots…"
          : null;
  const hintId = "task-screenshot-hint";
  return h.section(
    [h.Class("task-attachments"), h.AriaLabelledBy("task-attachments-heading")],
    [
      h.h2([h.Id("task-attachments-heading")], ["Attachments"]),
      h.div(
        [h.Class("task-attachment-actions")],
        [
          h.label(
            [h.Class("file-upload")],
            [
              h.span(
                [
                  h.Class(buttonClassName({ variant: "outline", size: "sm" })),
                  h.DataAttribute("slot", "button"),
                ],
                ["Add screenshot"],
              ),
              input(
                [
                  h.Type("file"),
                  h.Accept("image/png,image/jpeg,.png,.jpg,.jpeg"),
                  h.AriaLabel("Add screenshot"),
                  h.AriaDescribedBy(hintId),
                  h.DataAttribute("task-screenshot-picker", ""),
                  h.Disabled(busy || model.attachments === null),
                ],
                h,
              ),
            ],
          ),
          h.p(
            [h.Id(hintId)],
            [`Or paste a PNG or JPEG up to ${taskAttachmentLimitMiB} MiB.`],
          ),
        ],
      ),
      alert(
        {
          message: model.error,
          severity: "error",
          announcement: "status",
          action:
            model.error && model.attachments === null
              ? button(
                  {
                    size: "sm",
                    variant: "outline",
                    onClick: toParent(Message.Retried()),
                    children: ["Retry"],
                  },
                  h,
                )
              : undefined,
        },
        h,
      ),
      ...(status
        ? [h.div([h.Class("task-attachment-status")], [spinner(status, h)])]
        : []),
      ...(!model.attachments?.length
        ? []
        : [
            h.ul(
              [h.Class("task-attachment-list")],
              model.attachments.map((attachment) => {
                const href = taskAttachmentApi(taskId, attachment.id);
                return h.li(
                  [h.Key(attachment.id)],
                  [
                    h.a(
                      [
                        h.Class("task-attachment-preview"),
                        h.Href(href),
                        h.Target("_blank"),
                        h.Rel("noopener"),
                        h.AriaLabel(
                          `Open screenshot ${attachment.name} in a new tab`,
                        ),
                      ],
                      [
                        h.img([
                          h.Src(href),
                          h.Alt(attachment.name),
                          h.Loading("lazy"),
                        ]),
                      ],
                    ),
                    h.div(
                      [h.Class("task-attachment-caption")],
                      [
                        h.span([], [attachment.name]),
                        h.span(
                          [h.Class("task-attachment-size")],
                          [fileSize(attachment.size)],
                        ),
                      ],
                    ),
                    button(
                      {
                        size: "sm",
                        variant: "ghost",
                        disabled: busy,
                        ariaLabel: `Remove ${attachment.name}`,
                        onClick: toParent(
                          Message.Removed({ id: attachment.id }),
                        ),
                        children: ["Remove"],
                      },
                      h,
                    ),
                  ],
                );
              }),
            ),
          ]),
    ],
  );
};
