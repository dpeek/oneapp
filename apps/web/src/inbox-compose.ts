import { button, plusIcon } from "@oneapp/ui";
import { Effect, Schema } from "effect";
import { Command, Submodel, Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
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

export const Model = Schema.Struct({
  from: Schema.NullOr(Schema.String),
  body: EditorBody,
  attachments: OutgoingAttachments,
  loadingFiles: Schema.NullOr(Schema.String),
  reply: Schema.NullOr(ReplyDraft),
  request: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
type Model = typeof Model.Type;

export const initial: Model = {
  from: null,
  body: { text: "" },
  attachments: [],
  loadingFiles: null,
  reply: null,
  request: null,
  error: null,
};

export const Message = defineMessageUnion({
  Opened: { from: Schema.String },
  OpenedReply: { from: Schema.String, reply: ReplyDraft },
  Closed: {},
  Shown: {},
  Submitted: {},
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

const formId = "inbox-compose-form";

const Show = Mount.define("ShowInboxCompose", {
  args: { reply: Schema.NullOr(ReplyDraft) },
  messages: [Message.Shown],
  execute: ({ element, reply }) =>
    Effect.sync(() => {
      if (element instanceof HTMLDialogElement && !element.open) {
        if (reply) {
          const fields = element.querySelector("form")?.elements;
          const to = fields?.namedItem("to");
          const subject = fields?.namedItem("subject");
          const cc = fields?.namedItem("cc");
          if (cc instanceof HTMLInputElement) cc.value = reply.cc ?? "";
          // Seed the fields once so later renders preserve the owner's edits.
          if (to instanceof HTMLInputElement) to.value = reply.to;
          if (subject instanceof HTMLInputElement)
            subject.value = reply.subject;
        }
        element.showModal();
        if (reply?.mode === "forward")
          element.querySelector<HTMLInputElement>('input[name="to"]')?.focus();
        else if (reply)
          element.querySelector<HTMLElement>(mailEditor.tag)?.focus();
      }
      return Message.Shown();
    }),
});

const ReadFiles = Command.define("ReadMailFiles", {
  args: { request: Schema.String },
  messages: [Message.LoadedFiles],
  execute: ({ request }) =>
    Effect.promise(async () => {
      try {
        const input = document.getElementById("mail-files");
        const files =
          input instanceof HTMLInputElement
            ? Array.from(input.files ?? [])
            : [];
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
        if (input instanceof HTMLInputElement) input.value = "";
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
      if (
        files.length + (reply?.forwarded?.length ?? 0) > 20 ||
        files.reduce((sum, file) => sum + attachmentBytes(file.content), 0) +
          (reply?.forwarded ?? []).reduce((sum, file) => sum + file.size, 0) >
          outgoingAttachmentLimit
      )
        return Message.Failed({
          request,
          error: "Attachments must total at most 10 MB and 20 files.",
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
          error: "Attachments must total at most 10 MB and 20 files.",
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
    Opened: ({ from }) => ({
      model: model.from ? model : { ...initial, from },
    }),
    OpenedReply: ({ from, reply }) => ({
      model: model.from
        ? model
        : { ...initial, from, reply, body: { text: reply.text } },
    }),
    Closed: () => ({ model: model.request ? model : initial }),
    Shown: () => ({ model }),
    PickedFiles: () => {
      if (model.request || model.loadingFiles) return { model };
      const request = crypto.randomUUID();
      return {
        model: { ...model, loadingFiles: request },
        commands: [ReadFiles({ request })],
      };
    },
    LoadedFiles: ({ request, files, error }) => {
      if (model.loadingFiles !== request) return { model };
      const attachments = [...model.attachments, ...files];
      const valid = Schema.is(OutgoingAttachments)(attachments);
      return {
        model: {
          ...model,
          loadingFiles: null,
          attachments: valid ? attachments : model.attachments,
          error:
            error ??
            (valid
              ? null
              : "Attachments must total at most 10 MB and 20 files."),
        },
      };
    },
    RemovedFile: ({ index }) => ({
      model: model.request
        ? model
        : {
            ...model,
            attachments: model.attachments.filter((_, i) => i !== index),
          },
    }),
    RemovedForwarded: ({ part }) => ({
      model:
        model.request || !model.reply
          ? model
          : {
              ...model,
              reply: {
                ...model.reply,
                forwarded: model.reply.forwarded?.filter(
                  (file) => file.part !== part,
                ),
              },
            },
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
    Sent: ({ request }) => ({
      model: model.request === request ? initial : model,
    }),
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

export const view = Submodel.defineView<
  Model & { sender: string | undefined },
  Message
>((model, h) => {
  const pending = model.request !== null;
  const busy = pending || model.loadingFiles !== null;
  const editor = mailEditor.withMessage(h);
  return h.div(
    [h.Class("inbox-compose")],
    [
      button(
        {
          size: "sm",
          rounded: true,
          ariaLabel: "New email",
          children: [plusIcon(h, "16"), "New"],
          ...(model.sender
            ? { onClick: Message.Opened({ from: model.sender }) }
            : { disabled: true }),
        },
        h,
      ),
      ...(model.from
        ? [
            h.dialog(
              [
                h.Class("inbox-compose-dialog"),
                h.AriaLabelledBy("inbox-compose-title"),
                h.OnMount(Show({ reply: model.reply })),
                h.OnCancel(Message.Closed()),
              ],
              [
                h.h2(
                  [h.Id("inbox-compose-title")],
                  [
                    model.reply?.mode === "forward"
                      ? "Forward"
                      : model.reply?.mode === "reply-all"
                        ? "Reply all"
                        : model.reply
                          ? "Reply"
                          : "New email",
                  ],
                ),
                h.p(
                  [h.Class("inbox-compose-from")],
                  [h.strong([], ["From"]), model.from],
                ),
                ...(model.reply &&
                model.reply.mode !== "forward" &&
                !model.reply.threaded
                  ? [
                      h.p(
                        [],
                        [
                          "This email has no usable Message-ID. Mail apps may show the reply separately.",
                        ],
                      ),
                    ]
                  : []),
                ...(model.reply && !model.reply.text
                  ? [h.p([], ["There is no text preview to quote."])]
                  : []),
                h.form(
                  [
                    h.Id(formId),
                    h.Method("post"),
                    h.OnSubmit(Message.Submitted()),
                  ],
                  [
                    h.label(
                      [],
                      [
                        "To",
                        h.input([
                          h.Name("to"),
                          h.Type("email"),
                          h.Multiple(true),
                          h.Maxlength(inboxComposeLimits.to),
                          ...(!model.reply ? [h.Autofocus(true)] : []),
                          h.Required(true),
                          h.Readonly(pending),
                        ]),
                      ],
                    ),
                    h.label(
                      [],
                      [
                        "Cc",
                        h.input([
                          h.Name("cc"),
                          h.Type("email"),
                          h.Multiple(true),
                          h.Maxlength(inboxComposeLimits.to),
                          h.Readonly(pending),
                        ]),
                      ],
                    ),
                    h.label(
                      [],
                      [
                        "Subject",
                        h.input([
                          h.Name("subject"),
                          h.Type("text"),
                          h.Maxlength(inboxComposeLimits.subject),
                          h.Required(true),
                          h.Readonly(pending),
                        ]),
                      ],
                    ),
                    h.div(
                      [],
                      [
                        h.span([], ["Message"]),
                        editor([
                          h.Name("body"),
                          editor.Label("Message"),
                          editor.Value(model.body),
                          editor.ReadOnly(pending),
                          editor.OnBodyEdited((body) =>
                            Message.EditedBody({ body }),
                          ),
                        ]),
                      ],
                    ),
                    h.label(
                      [],
                      [
                        "Attach files (10 MB total)",
                        h.input([
                          h.Id("mail-files"),
                          h.Type("file"),
                          h.Multiple(true),
                          h.Disabled(busy),
                          h.OnChange(() => Message.PickedFiles()),
                        ]),
                      ],
                    ),
                    ...(model.loadingFiles
                      ? [h.p([h.Role("status")], ["Reading files…"])]
                      : []),
                    h.ul(
                      [],
                      [
                        ...model.attachments.map((file, index) =>
                          h.li(
                            [],
                            [
                              file.filename,
                              h.button(
                                [
                                  h.Type("button"),
                                  h.Disabled(busy),
                                  h.AriaLabel(`Remove ${file.filename}`),
                                  h.OnClick(Message.RemovedFile({ index })),
                                ],
                                ["Remove"],
                              ),
                            ],
                          ),
                        ),
                        ...(model.reply?.forwarded ?? []).map((file) =>
                          h.li(
                            [],
                            [
                              file.name,
                              h.button(
                                [
                                  h.Type("button"),
                                  h.Disabled(busy),
                                  h.AriaLabel(`Remove ${file.name}`),
                                  h.OnClick(
                                    Message.RemovedForwarded({
                                      part: file.part,
                                    }),
                                  ),
                                ],
                                ["Remove"],
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                    h.p([h.Role("alert")], [model.error ?? ""]),
                    h.div(
                      [h.Class("inbox-compose-actions")],
                      [
                        h.button(
                          [
                            h.Type("button"),
                            h.Disabled(pending),
                            h.OnClick(Message.Closed()),
                          ],
                          ["Cancel"],
                        ),
                        h.button(
                          [h.Type("submit"), h.Disabled(busy)],
                          [pending ? "Sending…" : "Send"],
                        ),
                      ],
                    ),
                  ],
                ),
              ],
            ),
          ]
        : []),
    ],
  );
});
