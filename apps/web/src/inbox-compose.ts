import { Effect, Schema } from "effect";
import { Command, Submodel, Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
import {
  inboxComposeLimits,
  InboxDraft,
  InboxMessageId,
  inboxSendPath,
  sentCopyHeader,
} from "./inbox-contract.ts";

const ReplyDraft = Schema.Struct({
  ...InboxDraft.fields,
  text: Schema.String,
  originalId: InboxMessageId,
  threaded: Schema.Boolean,
});

export const Model = Schema.Struct({
  from: Schema.NullOr(Schema.String),
  reply: Schema.NullOr(ReplyDraft),
  request: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  notice: Schema.NullOr(Schema.String),
});
type Model = typeof Model.Type;

export const initial: Model = {
  from: null,
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
  Sent: { request: Schema.String, saved: Schema.Boolean },
  Failed: { request: Schema.String, error: Schema.String },
  SessionExpired: { request: Schema.String },
});
type Message = typeof Message.Type;

const formId = "inbox-compose-form";
const uncertainSend = "Could not confirm whether the email was sent.";
const decodeError = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.String }),
);

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
          const text = fields?.namedItem("text");
          // Seed the fields once so later renders preserve the owner's edits.
          if (to instanceof HTMLInputElement) to.value = reply.to;
          if (subject instanceof HTMLInputElement)
            subject.value = reply.subject;
          if (text instanceof HTMLTextAreaElement) {
            text.value = reply.text;
            text.setSelectionRange(0, 0);
          }
        }
        element.showModal();
      }
      return Message.Shown();
    }),
});

const Send = Command.define("SendInboxEmail", {
  args: { request: Schema.String, replyToId: Schema.NullOr(InboxMessageId) },
  messages: [Message.Sent, Message.Failed, Message.SessionExpired],
  execute: ({ request, replyToId }) =>
    Effect.tryPromise(async (signal) => {
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
      const response = await fetch(inboxSendPath, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-effect-auth-csrf": "1",
        },
        body: JSON.stringify({
          ...draft.value,
          ...(replyToId ? { replyToId } : {}),
        }),
        signal,
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      if (response.status === 204)
        return Message.Sent({
          request,
          saved: response.headers.get(sentCopyHeader) !== "failed",
        });
      const result = decodeError(await response.json());
      return Message.Failed({
        request,
        error: result._tag === "Some" ? result.value.error : uncertainSend,
      });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(Message.Failed({ request, error: uncertainSend })),
      ),
    ),
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
      model: model.from ? model : { ...initial, from, reply },
    }),
    Closed: () => ({ model: model.request ? model : initial }),
    Shown: () => ({ model }),
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
    Sent: ({ request, saved }) => ({
      model:
        model.request === request
          ? {
              ...initial,
              notice: saved
                ? "Email sent."
                : "Email sent. Could not save a copy in Sent.",
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
  return h.div(
    [h.Class("inbox-compose")],
    [
      ...(model.sender
        ? [
            h.button(
              [
                h.Type("button"),
                h.Class("inbox-compose-button"),
                h.OnClick(Message.Opened({ from: model.sender })),
              ],
              ["Compose"],
            ),
          ]
        : []),
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
                    h.label(
                      [],
                      [
                        "Message",
                        h.textarea([
                          h.Name("text"),
                          h.Rows(8),
                          h.Maxlength(inboxComposeLimits.text),
                          ...(model.reply ? [h.Autofocus(true)] : []),
                          h.Required(true),
                          h.Readonly(pending),
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
