import { alert, button, buttonClassName, input, spinner } from "@orumai/ui";
import { Effect, Queue, Schema, Stream } from "effect";
import { Command, Mount, Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { detectFilePreviewType } from "./file-preview-type.ts";
import { fileSize } from "./file-display.ts";
import { FileName, fileNameHeader } from "./files-contract.ts";
import { ItemId } from "./items-contract.ts";
import {
  TaskAttachment,
  taskAttachmentIdHeader,
  TaskAttachmentMediaType,
  TaskAttachments,
  taskAttachmentApi,
  taskAttachmentLimit,
  taskAttachmentLimitMiB,
  taskAttachmentsApi,
} from "./task-attachment-contract.ts";

const UploadFile = Schema.instanceOf(File);
const UploadFiles = Schema.Array(UploadFile);

export const StagedScreenshot = Schema.Struct({
  id: ItemId,
  name: FileName,
  file: UploadFile,
  error: Schema.NullOr(Schema.String),
});
type StagedScreenshot = typeof StagedScreenshot.Type;
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
  Picked: { taskId: ItemId, files: UploadFiles },
  Removed: { id: ItemId },
  Retried: {},
  Loaded: { request: ItemId, ...TaskAttachments.fields },
  Uploaded: { request: ItemId, attachment: TaskAttachment },
  Deleted: { request: ItemId, id: ItemId },
  Failed: { request: ItemId, error: Schema.String },
  SessionExpired: { request: ItemId },
  Validated: {
    draftId: ItemId,
    screenshots: Schema.Array(StagedScreenshot),
    error: Schema.NullOr(Schema.String),
  },
  MountedPreview: {},
});
type Message = typeof Message.Type;
const OutMessage = defineMessageUnion({ SessionExpired: {} });
type OutMessage = typeof OutMessage.Type;

export const WatchEditor = Mount.defineStream("WatchTaskScreenshotInput", {
  args: { taskId: ItemId, draft: Schema.Boolean },
  messages: [Message.Opened, Message.Picked],
  execute: ({ element, taskId, draft }) =>
    Stream.callback<typeof Message.Opened.Type | typeof Message.Picked.Type>(
      (queue) => {
        const pick = (files: File[]) => {
          if (files.length)
            Queue.offerUnsafe(queue, Message.Picked({ taskId, files }));
        };
        const change = (event: Event) => {
          const target = event.target;
          if (
            !(target instanceof HTMLInputElement) ||
            !target.hasAttribute("data-task-screenshot-picker")
          )
            return;
          const files = Array.from(target.files ?? []);
          target.value = "";
          pick(files);
        };
        const paste = (event: Event) => {
          if (!(event instanceof ClipboardEvent)) return;
          const files = Array.from(event.clipboardData?.files ?? []);
          if (!files.length) return;
          event.preventDefault();
          pick(files);
        };
        const pasteScope = draft
          ? (element.closest("dialog") ?? element)
          : (element.closest(".task-detail") ?? element);
        return Effect.acquireRelease(
          Effect.sync(() => {
            element.addEventListener("change", change);
            pasteScope.addEventListener("paste", paste);
            if (!draft) Queue.offerUnsafe(queue, Message.Opened({ taskId }));
          }),
          () =>
            Effect.sync(() => {
              element.removeEventListener("change", change);
              pasteScope.removeEventListener("paste", paste);
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
const invalidType = "Choose or paste a PNG or JPEG image.";

const screenshotName = (file: File) =>
  file.name ||
  (file.type === "image/jpeg" ? "Screenshot.jpg" : "Screenshot.png");

const fileError = (file: File, name: string) =>
  file.size > taskAttachmentLimit
    ? tooLarge
    : !Schema.is(FileName)(name)
      ? "Rename the screenshot and try again."
      : null;

export const ValidateDraftScreenshots = Command.define(
  "ValidateDraftTaskScreenshots",
  {
    args: { draftId: ItemId, files: UploadFiles },
    messages: [Message.Validated],
    execute: ({ draftId, files }) =>
      Effect.promise(async () => {
        const screenshots: StagedScreenshot[] = [];
        const errors: string[] = [];
        for (const file of files) {
          const name = screenshotName(file);
          let error = fileError(file, name);
          if (!error) {
            try {
              const bytes = new Uint8Array(
                await file.slice(0, 8).arrayBuffer(),
              );
              if (
                !Schema.is(TaskAttachmentMediaType)(
                  detectFilePreviewType(bytes),
                )
              )
                error = invalidType;
            } catch {
              error = "Could not read the screenshot. Pick or paste it again.";
            }
          }
          if (error) errors.push(`${name}: ${error}`);
          else
            screenshots.push({
              id: crypto.randomUUID(),
              name,
              file,
              error: null,
            });
        }
        return Message.Validated({
          draftId,
          screenshots,
          error: errors.length ? errors.join(" ") : null,
        });
      }),
  },
);

const readFailure = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.String }),
);

const Transfer = Schema.Union([
  Schema.TaggedStruct("Load", {}),
  Schema.TaggedStruct("Upload", {
    file: UploadFile,
    name: FileName,
    id: Schema.optionalKey(ItemId),
  }),
  Schema.TaggedStruct("Remove", { id: ItemId }),
]);
type Transfer = typeof Transfer.Type;

export const Run = Command.define("ManageTaskScreenshots", {
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
    const fallback =
      transfer._tag === "Upload" && transfer.id
        ? "Could not upload this screenshot."
        : errors[transfer._tag];
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
                  ...(transfer.id
                    ? { [taskAttachmentIdHeader]: transfer.id }
                    : {}),
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
        return fail(fallback);
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
    }).pipe(Effect.catch(() => Effect.succeed(fail(fallback))));
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
    Picked: ({ taskId, files }) => {
      const file = files[0];
      if (taskId !== model.taskId || !file) return { model };
      if (model.request)
        return {
          model: {
            ...model,
            error:
              "Wait for the current screenshot operation, then paste it again.",
          },
        };
      const name = screenshotName(file);
      const error = fileError(file, name);
      return error
        ? { model: { ...model, error } }
        : start(model, { _tag: "Upload", file, name });
    },
    Removed: ({ id }) => start(model, { _tag: "Remove", id }),
    Retried: () => start(model, { _tag: "Load" }),
    Validated: () => ({ model }),
    MountedPreview: () => ({ model }),
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
  return screenshotSection(
    {
      hintId: "task-screenshot-hint",
      busy: busy || model.attachments === null,
      feedback: alert(
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
      status,
      screenshots: (model.attachments ?? []).map((attachment) => ({
        ...attachment,
        preview: savedPreview(taskId, attachment, h),
        remove: toParent(Message.Removed({ id: attachment.id })),
      })),
    },
    h,
  );
};

const savedPreview = <ParentMessage>(
  taskId: string,
  attachment: typeof TaskAttachment.Type,
  h: HtmlBuilder<ParentMessage>,
) => {
  const href = taskAttachmentApi(taskId, attachment.id);
  return h.a(
    [
      h.Class("task-attachment-preview"),
      h.Href(href),
      h.Target("_blank"),
      h.Rel("noopener"),
      h.AriaLabel(`Open screenshot ${attachment.name} in a new tab`),
    ],
    [h.img([h.Src(href), h.Alt(attachment.name), h.Loading("lazy")])],
  );
};

const PreviewDraftScreenshot = Mount.define("PreviewDraftTaskScreenshot", {
  args: { file: UploadFile },
  messages: [Message.MountedPreview],
  execute: ({ element, file }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const url = URL.createObjectURL(file);
        if (element instanceof HTMLImageElement) element.src = url;
        return url;
      }),
      (url) => Effect.sync(() => URL.revokeObjectURL(url)),
    ).pipe(Effect.as(Message.MountedPreview())),
});

export const draftSection = <ParentMessage>(
  screenshots: readonly StagedScreenshot[],
  options: {
    locked: boolean;
    status: string | null;
    error: string | null;
    onRemove: (id: string) => ParentMessage;
    toParent: (message: Message) => ParentMessage;
  },
  h: HtmlBuilder<ParentMessage>,
) =>
  screenshotSection(
    {
      hintId: "draft-task-screenshot-hint",
      draft: true,
      busy: options.locked,
      feedback: alert(
        { message: options.error, severity: "error", announcement: "status" },
        h,
      ),
      status: options.status,
      screenshots: screenshots.map(({ id, name, file, error }) => ({
        id,
        name,
        size: file.size,
        error,
        preview: h.span(
          [h.Class("task-attachment-preview")],
          [
            h.img([
              h.Alt(name),
              h.OnMount(
                Mount.mapMessage(
                  PreviewDraftScreenshot({ file }),
                  options.toParent,
                ),
              ),
            ]),
          ],
        ),
        remove: options.onRemove(id),
      })),
    },
    h,
  );

const screenshotSection = <ParentMessage>(
  {
    hintId,
    draft = false,
    busy,
    feedback,
    status,
    screenshots,
  }: {
    hintId: string;
    draft?: boolean;
    busy: boolean;
    feedback: Html;
    status: string | null;
    screenshots: readonly {
      id: string;
      name: string;
      size: number;
      error?: string | null;
      preview: Html;
      remove: ParentMessage;
    }[];
  },
  h: HtmlBuilder<ParentMessage>,
) => {
  return h.section(
    [
      h.Class("task-attachments"),
      ...(draft
        ? [h.AriaLabel("Attachments")]
        : [h.AriaLabelledBy("task-attachments-heading")]),
    ],
    [
      ...(draft
        ? []
        : [h.h2([h.Id("task-attachments-heading")], ["Attachments"])]),
      ...(!draft || !busy
        ? [
            h.div(
              [h.Class("task-attachment-actions")],
              [
                h.label(
                  [h.Class("file-upload")],
                  [
                    h.span(
                      [
                        h.Class(
                          buttonClassName({ variant: "outline", size: "sm" }),
                        ),
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
                        h.Multiple(draft),
                        h.Disabled(busy),
                      ],
                      h,
                    ),
                  ],
                ),
                h.p(
                  [h.Id(hintId)],
                  [
                    `Or paste a PNG or JPEG up to ${taskAttachmentLimitMiB} MiB.`,
                  ],
                ),
              ],
            ),
          ]
        : []),
      feedback,
      ...(status
        ? [h.div([h.Class("task-attachment-status")], [spinner(status, h)])]
        : []),
      ...(screenshots.length
        ? [
            h.ul(
              [h.Class("task-attachment-list")],
              screenshots.map(({ id, name, size, error, preview, remove }) =>
                h.li(
                  [h.Key(id)],
                  [
                    preview,
                    h.div(
                      [h.Class("task-attachment-caption")],
                      [
                        h.span([], [name]),
                        h.span(
                          [h.Class("task-attachment-size")],
                          [fileSize(size)],
                        ),
                        ...(error
                          ? [
                              h.span(
                                [h.Class("task-attachment-error")],
                                [error],
                              ),
                            ]
                          : []),
                      ],
                    ),
                    ...(draft && busy
                      ? []
                      : [
                          button(
                            {
                              size: "sm",
                              variant: "ghost",
                              disabled: busy,
                              ariaLabel: `Remove ${name}`,
                              onClick: remove,
                              children: ["Remove"],
                            },
                            h,
                          ),
                        ]),
                  ],
                ),
              ),
            ),
          ]
        : []),
    ],
  );
};
