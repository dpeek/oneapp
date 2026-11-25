import {
  alert,
  button,
  Dialog,
  field,
  fieldClassNames,
  fileInput,
  input,
} from "@oneapp/ui";
import { Effect, Option, Schema } from "effect";
import { Command, Submodel, Update } from "foldkit";
import type { ChildAttribute, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { EditorBody, mailEditor } from "./mail-editor-contract.ts";
import {
  inboxComposeLimits,
  InboxDraft,
  MailMessageId,
  InboxAttachment,
  inboxAttachmentApi,
  OutgoingAttachments,
  outgoingAttachmentLimit,
  attachmentBytes,
  inboxSendPath,
} from "./inbox-contract.ts";
import { sendInboxRequest, SentConfirmation } from "./inbox-send.ts";

const ReplyDraft = Schema.Struct({
  ...InboxDraft.fields,
  to: Schema.String,
  text: Schema.String,
  originalId: MailMessageId,
  mode: Schema.optionalKey(Schema.Literals(["reply", "reply-all", "forward"])),
  forwarded: Schema.optionalKey(Schema.Array(InboxAttachment)),
  threaded: Schema.Boolean,
});

export const dialogId = "inbox-compose";
const formId = "inbox-compose-form";
const fileInputId = "mail-files";
const attachmentLimitError =
  "Attachments must total at most 10 MB and 20 files.";
const Header = Schema.Literals(["to", "cc", "subject"]);

export const Model = Schema.Struct({
  dialog: Dialog.Model,
  from: Schema.NullOr(Schema.String),
  headers: Schema.Record(Header, Schema.String),
  body: EditorBody,
  attachments: OutgoingAttachments,
  loadingFiles: Schema.NullOr(Schema.String),
  fileError: Schema.NullOr(Schema.String),
  reply: Schema.NullOr(ReplyDraft),
  request: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
type Model = typeof Model.Type;

export const initial: Model = {
  dialog: Dialog.init({ id: dialogId }),
  from: null,
  headers: { to: "", cc: "", subject: "" },
  body: { text: "" },
  attachments: [],
  loadingFiles: null,
  fileError: null,
  reply: null,
  request: null,
  error: null,
};

export const Message = defineMessageUnion({
  Opened: { from: Schema.String },
  OpenedReply: { from: Schema.String, reply: ReplyDraft },
  Closed: {},
  GotDialogMessage: { message: Dialog.Message },
  Submitted: {},
  EditedHeader: { field: Header, value: Schema.String },
  EditedBody: { body: EditorBody },
  PickedFiles: {},
  LoadedFiles: {
    request: Schema.String,
    files: OutgoingAttachments,
    error: Schema.NullOr(Schema.String),
  },
  RemovedFile: { index: Schema.Number },
  RemovedForwarded: { part: Schema.Number },
  Sent: { request: Schema.String, ...SentConfirmation },
  Failed: { request: Schema.String, error: Schema.String },
  SendFailed: { request: Schema.String, error: Schema.String },
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

const openDraft = (model: Model, from: string, reply: Model["reply"] = null) =>
  model.dialog.isOpen
    ? { model }
    : foldDialog(
        model.from
          ? model
          : {
              ...initial,
              from,
              reply,
              headers: {
                to: reply?.to ?? "",
                cc: reply?.cc ?? "",
                subject: reply?.subject ?? "",
              },
              body: { text: reply?.text ?? "" },
            },
        Dialog.Message.RequestedOpen(),
      );

const closeDraft = (model: Model) =>
  foldDialog(
    { ...initial, dialog: model.dialog },
    Dialog.Message.RequestedClose(),
  );

const withinAttachmentLimits = (
  files: typeof OutgoingAttachments.Type,
  forwarded: readonly (typeof InboxAttachment.Type)[] = [],
) =>
  files.length + forwarded.length <= 20 &&
  files.reduce((sum, file) => sum + attachmentBytes(file.content), 0) +
    forwarded.reduce((sum, file) => sum + file.size, 0) <=
    outgoingAttachmentLimit;

const ReadFiles = Command.define("ReadMailFiles", {
  args: { request: Schema.String },
  messages: [Message.LoadedFiles],
  execute: ({ request }) =>
    Effect.promise(async () => {
      try {
        const input = document.getElementById(fileInputId);
        const files =
          input instanceof HTMLInputElement
            ? Array.from(input.files ?? [])
            : [];
        if (input instanceof HTMLInputElement) input.value = "";
        if (
          files.length > 20 ||
          files.reduce((size, file) => size + file.size, 0) >
            outgoingAttachmentLimit
        )
          throw new Error("Choose up to 20 files, totaling at most 10 MB.");
        const encoded = await Promise.all(
          files.map(async (file) => ({
            filename: file.name,
            type: file.type || "application/octet-stream",
            content: new Uint8Array(await file.arrayBuffer()).toBase64(),
          })),
        );
        if (!Schema.is(OutgoingAttachments)(encoded))
          throw new Error(
            "One of these files has an unsupported filename or type.",
          );
        return Message.LoadedFiles({ request, files: encoded, error: null });
      } catch (error) {
        return Message.LoadedFiles({
          request,
          files: [],
          error:
            error instanceof Error
              ? error.message
              : "Could not read attachments.",
        });
      }
    }),
});

const Send = Command.define("SendInboxEmail", {
  args: {
    request: Schema.String,
    reply: Schema.NullOr(ReplyDraft),
    attachments: OutgoingAttachments,
  },
  messages: [
    Message.Sent,
    Message.Failed,
    Message.SendFailed,
    Message.SessionExpired,
  ],
  execute: ({ request, reply, attachments }) =>
    Effect.promise(async (signal) => {
      const form = document.getElementById(formId);
      const input =
        form instanceof HTMLFormElement
          ? Object.fromEntries(new FormData(form))
          : null;
      const files = [...attachments];
      if (!withinAttachmentLimits(files, reply?.forwarded))
        return Message.Failed({
          request,
          error: attachmentLimitError,
        });
      try {
        for (const file of reply?.forwarded ?? []) {
          const response = await fetch(
            inboxAttachmentApi(reply!.originalId, file.part),
            { signal },
          );
          if (response.status === 401)
            return Message.SessionExpired({ request });
          if (!response.ok)
            throw new Error(
              "Could not load an original attachment. Remove it or try again.",
            );
          files.push({
            filename: file.name,
            type: file.mediaType,
            content: new Uint8Array(await response.arrayBuffer()).toBase64(),
          });
        }
      } catch {
        return Message.Failed({
          request,
          error:
            "Could not load an original attachment. Remove it or try again.",
        });
      }
      if (!Schema.is(OutgoingAttachments)(files))
        return Message.Failed({
          request,
          error: attachmentLimitError,
        });
      const draft = Schema.decodeUnknownOption(InboxDraft)({
        ...input,
        attachments: files,
      });
      if (draft._tag === "None") {
        return Message.Failed({
          request,
          error: "Enter valid recipients, a subject, and a message.",
        });
      }
      const result = await sendInboxRequest(
        inboxSendPath,
        {
          ...draft.value,
          ...(reply && reply.mode !== "forward"
            ? { replyToId: reply.originalId }
            : {}),
        },
        signal,
      );
      switch (result._tag) {
        case "SessionExpired":
          return Message.SessionExpired({ request });
        case "Sent":
          return Message.Sent({
            request,
            saved: result.saved,
            sentId: result.sentId,
            completion: result.completion,
          });
        case "Failed":
          return Message.SendFailed({ request, error: result.error });
      }
    }),
});

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    Opened: ({ from }) => openDraft(model, from),
    OpenedReply: ({ from, reply }) => openDraft(model, from, reply),
    Closed: () => (model.request ? { model } : closeDraft(model)),
    GotDialogMessage: ({ message }) => {
      if (message._tag === "RequestedClose")
        return model.request ? { model } : closeDraft(model);
      const result = foldDialog(model, message);
      return model.dialog.isOpen &&
        !result.model.dialog.isOpen &&
        !model.request
        ? { ...result, model: { ...initial, dialog: result.model.dialog } }
        : result;
    },
    PickedFiles: () => {
      if (!model.from || model.request || model.loadingFiles) return { model };
      const request = crypto.randomUUID();
      return {
        model: { ...model, loadingFiles: request, fileError: null },
        commands: [ReadFiles({ request })],
      };
    },
    LoadedFiles: ({ request, files, error }) => {
      if (model.loadingFiles !== request) return { model };
      const attachments = [...model.attachments, ...files];
      const valid =
        !error && withinAttachmentLimits(attachments, model.reply?.forwarded);
      return {
        model: {
          ...model,
          loadingFiles: null,
          attachments: valid ? attachments : model.attachments,
          fileError: error ?? (valid ? null : attachmentLimitError),
        },
      };
    },
    RemovedFile: ({ index }) => ({
      model:
        model.request || model.loadingFiles
          ? model
          : {
              ...model,
              attachments: model.attachments.filter((_, i) => i !== index),
              fileError: null,
            },
    }),
    RemovedForwarded: ({ part }) => ({
      model:
        model.request || model.loadingFiles || !model.reply
          ? model
          : {
              ...model,
              fileError: null,
              reply: {
                ...model.reply,
                forwarded: model.reply.forwarded?.filter(
                  (file) => file.part !== part,
                ),
              },
            },
    }),
    EditedHeader: ({ field, value }) => ({
      model: model.request
        ? model
        : { ...model, headers: { ...model.headers, [field]: value } },
    }),
    EditedBody: ({ body }) => ({
      model: model.request ? model : { ...model, body, error: null },
    }),
    Submitted: () => {
      if (!model.from || model.request || model.loadingFiles) return { model };
      const request = crypto.randomUUID();
      return {
        model: { ...model, request, error: null },
        commands: [
          Send({ request, reply: model.reply, attachments: model.attachments }),
        ],
      };
    },
    Sent: ({ request }) =>
      model.request === request ? closeDraft(model) : { model },
    Failed: ({ request, error }) => ({
      model:
        model.request === request ? { ...model, request: null, error } : model,
    }),
    SendFailed: ({ request }) => ({
      model:
        model.request === request
          ? { ...model, request: null, error: null }
          : model,
    }),
    SessionExpired: () => ({ model }),
  });

const composeTitle = (reply: Model["reply"]) => {
  if (reply?.mode === "forward") return "Forward";
  if (reply?.mode === "reply-all") return "Reply all";
  return reply ? "Reply" : "New email";
};

const composeForm = (
  model: Model,
  initialFocus: ReadonlyArray<ChildAttribute>,
  h: HtmlBuilder<Message>,
) => {
  const { reply } = model;
  const pending = model.request !== null;
  const preparing = model.loadingFiles !== null;
  const busy = pending || preparing;
  const focusMessage = reply !== null && reply.mode !== "forward";
  const editor = mailEditor.withMessage(h);
  const headerField = (name: typeof Header.Type, label: string) => {
    const recipient = name !== "subject";
    return field(
      label,
      input(
        [
          h.Name(name),
          h.Type(recipient ? "email" : "text"),
          ...(recipient ? [h.Multiple(true)] : []),
          h.Maxlength(
            recipient ? inboxComposeLimits.to : inboxComposeLimits.subject,
          ),
          h.Required(name !== "cc"),
          h.Readonly(pending),
          h.Value(model.headers[name]),
          h.OnInput((value) => Message.EditedHeader({ field: name, value })),
          ...(name === "to" && !focusMessage ? initialFocus : []),
        ],
        h,
      ),
      h,
    );
  };
  const removeButton = (name: string, onClick: Message) =>
    button(
      {
        variant: "ghost",
        size: "sm",
        ariaLabel: `Remove ${name}`,
        disabled: busy,
        onClick,
        children: ["Remove"],
      },
      h,
    );
  const attachments = [
    ...model.attachments.map((file, index) =>
      h.li(
        [],
        [
          h.span([], [file.filename]),
          removeButton(file.filename, Message.RemovedFile({ index })),
        ],
      ),
    ),
    ...(reply?.forwarded ?? []).map((file) =>
      h.li(
        [h.Key(`forwarded-${file.part}`)],
        [
          h.span([], [file.name]),
          removeButton(
            file.name,
            Message.RemovedForwarded({ part: file.part }),
          ),
        ],
      ),
    ),
  ];

  return h.div(
    [h.Class("inbox-compose-content")],
    [
      h.p(
        [h.Class("inbox-compose-from")],
        [h.strong([], ["From"]), model.from ?? ""],
      ),
      ...(reply && reply.mode !== "forward" && !reply.threaded
        ? [
            h.p(
              [],
              [
                "This email has no usable Message-ID. Mail apps may show the reply separately.",
              ],
            ),
          ]
        : []),
      ...(reply && !reply.text
        ? [h.p([], ["There is no text preview to quote."])]
        : []),
      h.form(
        [
          h.Id(formId),
          h.Class("inbox-compose-form"),
          h.Method("post"),
          h.OnSubmit(Message.Submitted()),
        ],
        [
          headerField("to", "To"),
          headerField("cc", "Cc"),
          headerField("subject", "Subject"),
          h.div(
            [h.DataAttribute("slot", "field"), h.Class(fieldClassNames.root)],
            [
              h.span(
                [
                  h.DataAttribute("slot", "field-label"),
                  h.Class(fieldClassNames.label),
                ],
                ["Message"],
              ),
              editor([
                h.Name("body"),
                ...(focusMessage ? [h.Tabindex(-1), ...initialFocus] : []),
                editor.Label("Message"),
                editor.Value(model.body),
                editor.ReadOnly(pending),
                editor.OnBodyEdited((body) => Message.EditedBody({ body })),
              ]),
            ],
          ),
          fileInput(
            {
              id: fileInputId,
              label: "Attach files (10 MB total)",
              multiple: true,
              disabled: pending,
              pending: preparing,
              error: model.fileError,
              onChange: Message.PickedFiles(),
            },
            h,
          ),
          ...(attachments.length
            ? [h.ul([h.Class("inbox-compose-attachments")], attachments)]
            : []),
          alert(
            { message: model.error, severity: "error", announcement: "alert" },
            h,
          ),
          Dialog.footer(
            [
              button(
                {
                  variant: "outline",
                  disabled: pending,
                  onClick: Message.Closed(),
                  children: ["Cancel"],
                },
                h,
              ),
              button(
                {
                  type: "submit",
                  disabled: busy,
                  focusableWhenDisabled: true,
                  children: [pending ? "Sending…" : "Send"],
                },
                h,
              ),
            ],
            h,
          ),
        ],
      ),
    ],
  );
};

export const view = Submodel.defineView<Model, Message>((model, h) =>
  Dialog.view(
    {
      model: model.dialog,
      title: composeTitle(model.reply),
      size: "wide",
      showCloseButton: false,
      content: (initialFocus) => composeForm(model, initialFocus, h),
      toParentMessage: toDialogMessage,
    },
    h,
  ),
);
