import { button, plusIcon } from "@oneapp/ui";
import { Effect, Schema } from "effect";
import { Command, Submodel, Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
import { EditorBody, mailEditor } from "./mail-editor-contract.ts";
import {
  inboxComposeLimits,
  InboxDraft,
  InboxMessageId,
  inboxSendPath,
} from "./inbox-contract.ts";
import {
  sendInboxRequest,
  SentConfirmation,
  sentNotice,
} from "./inbox-send.ts";

const ReplyDraft = Schema.Struct({
  ...InboxDraft.fields,
  text: Schema.String,
  originalId: InboxMessageId,
  threaded: Schema.Boolean,
});

export const Model = Schema.Struct({
  from: Schema.NullOr(Schema.String),
  body: EditorBody,
  reply: Schema.NullOr(ReplyDraft),
  request: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  notice: Schema.NullOr(Schema.String),
});
type Model = typeof Model.Type;

export const initial: Model = {
  from: null,
  body: { text: "" },
  reply: null,
  request: null,
  error: null,
  notice: null,
};

export const Message = defineMessageUnion({
  Opened: { from: Schema.String },
  OpenedReply: { from: Schema.String, reply: ReplyDraft },
  Closed: {},
  Shown: {},
  Submitted: {},
  EditedBody: { body: EditorBody },
  Sent: { request: Schema.String, ...SentConfirmation },
  Failed: { request: Schema.String, error: Schema.String },
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
          // Seed the fields once so later renders preserve the owner's edits.
          if (to instanceof HTMLInputElement) to.value = reply.to;
          if (subject instanceof HTMLInputElement)
            subject.value = reply.subject;
        }
        element.showModal();
        if (reply) element.querySelector<HTMLElement>(mailEditor.tag)?.focus();
      }
      return Message.Shown();
    }),
});

const Send = Command.define("SendInboxEmail", {
  args: { request: Schema.String, replyToId: Schema.NullOr(InboxMessageId) },
  messages: [Message.Sent, Message.Failed, Message.SessionExpired],
  execute: ({ request, replyToId }) =>
    Effect.promise(async (signal) => {
      const form = document.getElementById(formId);
      const input =
        form instanceof HTMLFormElement
          ? Object.fromEntries(new FormData(form))
          : null;
      const draft = Schema.decodeUnknownOption(InboxDraft)(input);
      if (draft._tag === "None") {
        return Message.Failed({
          request,
          error: "Enter one valid recipient, a subject, and a message.",
        });
      }
      const result = await sendInboxRequest(
        inboxSendPath,
        {
          ...draft.value,
          ...(replyToId ? { replyToId } : {}),
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
          return Message.Failed({ request, error: result.error });
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
    EditedBody: ({ body }) => ({
      model: model.request ? model : { ...model, body, error: null },
    }),
    Submitted: () => {
      if (!model.from || model.request) return { model };
      const request = crypto.randomUUID();
      return {
        model: { ...model, request, error: null },
        commands: [
          Send({ request, replyToId: model.reply?.originalId ?? null }),
        ],
      };
    },
    Sent: ({ request, saved, completion }) => ({
      model:
        model.request === request
          ? {
              ...initial,
              notice: sentNotice(saved, completion),
            }
          : model,
    }),
    Failed: ({ request, error }) => ({
      model:
        model.request === request ? { ...model, request: null, error } : model,
    }),
    SessionExpired: () => ({ model }),
  });

export const view = Submodel.defineView<
  Model & { sender: string | undefined },
  Message
>((model, h) => {
  const pending = model.request !== null;
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
      h.p([h.Role("status")], [model.notice ?? ""]),
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
                  [model.reply ? "Reply" : "New email"],
                ),
                h.p(
                  [h.Class("inbox-compose-from")],
                  [h.strong([], ["From"]), model.from],
                ),
                ...(model.reply && !model.reply.threaded
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
                          [h.Type("submit"), h.Disabled(pending)],
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
