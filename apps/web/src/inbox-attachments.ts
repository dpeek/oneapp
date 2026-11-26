import { button, buttonClassName, Dialog, outlineIcon } from "@orumai/ui";
import { fileSize, renderPdf } from "./file-display.ts";
import { Effect, Option, Schema } from "effect";
import { Submodel, Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
import {
  AttachmentPart,
  type InboxAttachment,
  inboxAttachmentApi,
  inboxAttachmentPreviewApi,
  inboxAttachmentTextPreviewLimit,
  MailMessageId,
} from "./inbox-contract.ts";

const Location = {
  id: MailMessageId,
  part: AttachmentPart,
};

const State = Schema.Struct({
  ...Location,
  request: Schema.String,
  status: Schema.Literals(["loading", "ready", "failed"]),
});
type State = typeof State.Type;

const dialogId = "mail-attachment-preview";
export const Model = Schema.Struct({
  dialog: Dialog.Model,
  preview: Schema.NullOr(State),
});
type Model = typeof Model.Type;

export const initial: Model = {
  dialog: Dialog.init({
    id: dialogId,
    focusSelector: '[data-slot="dialog-close"]',
  }),
  preview: null,
};

export const Message = defineMessageUnion({
  Opened: Location,
  GotDialogMessage: { message: Dialog.Message },
  Ready: { request: Schema.String },
  Failed: { request: Schema.String },
  SessionExpired: { request: Schema.String },
});
type Message = typeof Message.Type;

const toDialogMessage = (message: typeof Dialog.Message.Type) =>
  Message.GotDialogMessage({ message });
const foldDialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.dialog),
  write: (model, dialog) => ({ ...model, dialog }),
  toParentMessage: toDialogMessage,
  foldOutMessage: () => (model) => ({ model }),
});

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    Opened: ({ id, part }) =>
      foldDialog(
        {
          ...model,
          preview: {
            id,
            part,
            request: crypto.randomUUID(),
            status: "loading",
          },
        },
        Dialog.Message.RequestedOpen(),
      ),
    GotDialogMessage: ({ message }) => {
      const result = foldDialog(model, message);
      return !result.model.dialog.isOpen && result.model.preview
        ? { ...result, model: { ...result.model, preview: null } }
        : result;
    },
    Ready: ({ request }) => ({
      model:
        request === model.preview?.request
          ? { ...model, preview: { ...model.preview, status: "ready" } }
          : model,
    }),
    Failed: ({ request }) => ({
      model:
        request === model.preview?.request
          ? { ...model, preview: { ...model.preview, status: "failed" } }
          : model,
    }),
    SessionExpired: () => ({ model }),
  });

const RenderDocument = Mount.define("RenderInboxAttachmentDocument", {
  args: {
    ...Location,
    request: Schema.String,
    kind: Schema.Literals(["pdf", "text"]),
    trash: Schema.Boolean,
  },
  messages: [Message.Ready, Message.Failed, Message.SessionExpired],
  execute: ({ element, id, part, request, kind, trash }) =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(inboxAttachmentPreviewApi(id, part, trash), {
        cache: "no-store",
        signal,
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      if (!response.ok) return Message.Failed({ request });
      if (kind === "pdf") {
        const canvas = await renderPdf(await response.arrayBuffer());
        if (element.isConnected) element.replaceChildren(canvas);
      } else {
        const text = await response.text();
        const pre = document.createElement("pre");
        pre.textContent = text;
        if (element.isConnected) element.replaceChildren(pre);
      }
      return Message.Ready({ request });
    }).pipe(Effect.catch(() => Effect.succeed(Message.Failed({ request })))),
});

const downloadLink = (
  h: HtmlBuilder<Message>,
  id: string,
  attachment: InboxAttachment,
  trash: boolean,
) =>
  h.a(
    [
      h.Href(inboxAttachmentApi(id, attachment.part, trash)),
      h.Download(attachment.name),
      h.DataAttribute("slot", "button"),
      h.AriaLabel(`Download ${attachment.name}`),
      h.Title(`Download ${attachment.name}`),
      h.Class(buttonClassName({ variant: "ghost", size: "icon-sm" })),
    ],
    [outlineIcon(h, ["M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"])],
  );

const previewContent = (
  h: HtmlBuilder<Message>,
  attachment: InboxAttachment,
  preview: State,
  trash: boolean,
) => {
  const { id, part, request, status } = preview;
  return h.div(
    [h.Key(request), h.Class("inbox-attachment-preview")],
    [
      ...(status === "loading"
        ? [h.p([h.Role("status")], ["Loading preview…"])]
        : []),
      ...(status === "failed"
        ? [
            h.p(
              [h.Role("alert")],
              [
                "Could not preview this attachment. You can download it instead.",
              ],
            ),
          ]
        : attachment.preview === "image"
          ? [
              h.img([
                h.Class("inbox-attachment-image"),
                h.Src(inboxAttachmentPreviewApi(id, part, trash)),
                h.Alt(attachment.name),
                h.OnLoad(Message.Ready({ request })),
                h.OnError(Message.Failed({ request })),
              ]),
            ]
          : attachment.preview
            ? [
                h.div(
                  [
                    h.Class("inbox-attachment-document"),
                    h.OnMount(
                      RenderDocument({
                        id,
                        part,
                        request,
                        kind: attachment.preview,
                        trash,
                      }),
                    ),
                  ],
                  [],
                ),
              ]
            : []),
      ...(status === "ready" && attachment.preview === "pdf"
        ? [h.p([h.Class("inbox-attachment-caption")], ["First page preview"])]
        : []),
      ...(status === "ready" &&
      attachment.preview === "text" &&
      attachment.size > inboxAttachmentTextPreviewLimit
        ? [
            h.p(
              [h.Class("inbox-attachment-caption")],
              [
                `Showing the first ${fileSize(inboxAttachmentTextPreviewLimit)}.`,
              ],
            ),
          ]
        : []),
    ],
  );
};

export const listView = Submodel.defineView<
  {
    id: string;
    attachments: readonly InboxAttachment[];
    trash?: boolean;
  },
  Message
>(({ id, attachments, trash = false }, h) => {
  return h.section(
    [h.Class("inbox-attachments"), h.AriaLabel("Attachments")],
    [
      h.ul(
        [],
        attachments.map((attachment) =>
          h.li(
            [h.Key(String(attachment.part))],
            [
              h.div(
                [h.Class("inbox-attachment-details")],
                [
                  h.strong([], [attachment.name]),
                  h.span([], [fileSize(attachment.size)]),
                ],
              ),
              button(
                {
                  variant: "ghost",
                  size: "icon-sm",
                  ariaLabel: `Preview ${attachment.name}`,
                  dialogId,
                  attributes: [
                    h.Title(
                      attachment.preview
                        ? `Preview ${attachment.name}`
                        : "Preview unavailable for this file type",
                    ),
                  ],
                  disabled: !attachment.preview,
                  onClick: Message.Opened({ id, part: attachment.part }),
                  children: [
                    outlineIcon(h, [
                      "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z",
                      "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
                    ]),
                  ],
                },
                h,
              ),
              downloadLink(h, id, attachment, trash),
            ],
          ),
        ),
      ),
    ],
  );
});

export const previewView = Submodel.defineView<
  {
    id: string;
    attachments: readonly InboxAttachment[];
    state: Model;
    trash: boolean;
  },
  Message
>(({ id, attachments, state: { dialog, preview }, trash }, h) => {
  const selected =
    preview?.id === id && attachments.find(({ part }) => part === preview.part);
  return Dialog.view(
    {
      model: dialog,
      size: "extra-wide",
      title: selected ? selected.name : "",
      headerActions: selected ? [downloadLink(h, id, selected, trash)] : [],
      content: () =>
        selected && preview
          ? previewContent(h, selected, preview, trash)
          : h.empty,
      toParentMessage: toDialogMessage,
    },
    h,
  );
});
