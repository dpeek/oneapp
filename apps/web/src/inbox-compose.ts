import { Effect, Schema } from "effect";
import { Command, Submodel, Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
import {
  inboxComposeLimits,
  InboxDraft,
  inboxSendPath,
} from "./inbox-contract.ts";

export const Model = Schema.Struct({
  from: Schema.NullOr(Schema.String),
  request: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  sent: Schema.Boolean,
});
type Model = typeof Model.Type;

export const initial: Model = {
  from: null,
  request: null,
  error: null,
  sent: false,
};

export const Message = defineMessageUnion({
  Opened: { from: Schema.String },
  Closed: {},
  Shown: {},
  Submitted: {},
  Sent: { request: Schema.String },
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
  messages: [Message.Shown],
  execute: ({ element }) =>
    Effect.sync(() => {
      if (element instanceof HTMLDialogElement && !element.open)
        element.showModal();
      return Message.Shown();
    }),
});

const Send = Command.define("SendInboxEmail", {
  args: { request: Schema.String },
  messages: [Message.Sent, Message.Failed, Message.SessionExpired],
  execute: ({ request }) =>
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
        body: JSON.stringify(draft.value),
        signal,
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      if (response.status === 204) return Message.Sent({ request });
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
    Closed: () => ({ model: model.request ? model : initial }),
    Shown: () => ({ model }),
    Submitted: () => {
      if (!model.from || model.request) return { model };
      const request = crypto.randomUUID();
      return {
        model: { ...model, request, error: null },
        commands: [Send({ request })],
      };
    },
    Sent: ({ request }) => ({
      model: model.request === request ? { ...initial, sent: true } : model,
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
      h.p([h.Role("status")], [model.sent ? "Email sent." : ""]),
      ...(model.from
        ? [
            h.dialog(
              [
                h.Class("inbox-compose-dialog"),
                h.AriaLabelledBy("inbox-compose-title"),
                h.OnMount(Show()),
                h.OnCancel(Message.Closed()),
              ],
              [
                h.h2([h.Id("inbox-compose-title")], ["New email"]),
                h.p(
                  [h.Class("inbox-compose-from")],
                  [h.strong([], ["From"]), model.from],
                ),
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
                          h.Autofocus(true),
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
