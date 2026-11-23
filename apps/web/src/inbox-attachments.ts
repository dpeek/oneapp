import { button, buttonClassName, outlineIcon } from "@oneapp/ui";
import { Effect, Schema } from "effect";
import { Submodel } from "foldkit";
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

export const State = Schema.NullOr(
  Schema.Struct({
    ...Location,
    request: Schema.String,
    status: Schema.Literals(["loading", "ready", "failed"]),
  }),
);
type State = typeof State.Type;

export const Message = defineMessageUnion({
  Opened: Location,
  Closed: {},
  Mounted: {},
  Ready: { request: Schema.String },
  Failed: { request: Schema.String },
  SessionExpired: { request: Schema.String },
});
type Message = typeof Message.Type;

export const update = (model: State, message: Message) =>
  Message.match<{ model: State }>(message, {
    Opened: ({ id, part }) => ({
      model: { id, part, request: crypto.randomUUID(), status: "loading" },
    }),
    Closed: () => ({ model: null }),
    Mounted: () => ({ model }),
    Ready: ({ request }) => ({
      model: request === model?.request ? { ...model, status: "ready" } : model,
    }),
    Failed: ({ request }) => ({
      model:
        request === model?.request ? { ...model, status: "failed" } : model,
    }),
    SessionExpired: () => ({ model }),
  });

const ShowPreview = Mount.define("ShowInboxAttachmentPreview", {
  messages: [Message.Mounted],
  execute: ({ element }) =>
    Effect.sync(() => {
      if (element instanceof HTMLDialogElement && !element.open)
        element.showModal();
      return Message.Mounted();
    }),
});

const renderPdf = async (data: ArrayBuffer) => {
  const pdf = await import("pdfjs-dist");
  pdf.GlobalWorkerOptions.workerSrc = `/pdf.worker-${pdf.version}.mjs`;
  const loading = pdf.getDocument({
    data,
    enableXfa: false,
    useWasm: false,
    useSystemFonts: true,
    maxImageSize: 16_000_000,
  });
  try {
    const pdfDocument = await loading.promise;
    const page = await pdfDocument.getPage(1);
    const natural = page.getViewport({ scale: 1 });
    const scale = Math.min(1.5, 1100 / natural.width, 1500 / natural.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "PDF page 1");
    await page.render({
      canvas,
      viewport,
      annotationMode: pdf.AnnotationMode.DISABLE,
    }).promise;
    return canvas;
  } finally {
    await loading.destroy();
  }
};

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

const formats = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const fileSize = (size: number) =>
  size >= 1024 * 1024
    ? `${formats.format(size / (1024 * 1024))} MB`
    : size >= 1024
      ? `${formats.format(size / 1024)} KB`
      : `${size} B`;

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
      h.Class(
        buttonClassName({ variant: "ghost", size: "icon-sm", rounded: true }),
      ),
    ],
    [outlineIcon(h, ["M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"])],
  );

const previewDialog = (
  h: HtmlBuilder<Message>,
  attachment: InboxAttachment,
  preview: NonNullable<State>,
  trash: boolean,
) => {
  const { id, part, request, status } = preview;
  return h.dialog(
    [
      h.Key(request),
      h.Class("inbox-attachment-dialog"),
      h.AriaLabelledBy("inbox-attachment-title"),
      h.OnMount(ShowPreview()),
      h.OnCancel(Message.Closed()),
    ],
    [
      h.header(
        [h.Class("inbox-attachment-dialog-header")],
        [
          h.h3([h.Id("inbox-attachment-title")], [attachment.name]),
          downloadLink(h, id, attachment, trash),
          button(
            {
              variant: "ghost",
              size: "icon-sm",
              rounded: true,
              ariaLabel: "Close preview",
              attributes: [h.Title("Close preview")],
              onClick: Message.Closed(),
              children: [outlineIcon(h, ["M6 6l12 12M6 18 18 6"])],
            },
            h,
          ),
        ],
      ),
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
              h.button(
                [
                  h.Type("button"),
                  h.DataAttribute("slot", "button"),
                  h.Class(
                    buttonClassName({
                      variant: "ghost",
                      size: "icon-sm",
                      rounded: true,
                    }),
                  ),
                  h.AriaLabel(`Preview ${attachment.name}`),
                  h.Title(
                    attachment.preview
                      ? `Preview ${attachment.name}`
                      : "Preview unavailable for this file type",
                  ),
                  h.Disabled(!attachment.preview),
                  h.OnClick(Message.Opened({ id, part: attachment.part })),
                ],
                [
                  outlineIcon(h, [
                    "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z",
                    "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
                  ]),
                ],
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
    preview: State;
    trash: boolean;
  },
  Message
>(({ id, attachments, preview, trash }, h) => {
  const selected =
    preview?.id === id && attachments.find(({ part }) => part === preview.part);
  return selected && preview
    ? previewDialog(h, selected, preview, trash)
    : h.empty;
});
