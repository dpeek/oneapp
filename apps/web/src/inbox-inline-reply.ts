import { Effect, Schema } from "effect";
import { Command, Submodel, Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import {
  inboxComposeLimits,
  inboxReplyApi,
  InlineReply,
  MailMessageId,
} from "./inbox-contract.ts";
import { sendInboxRequest, sentNotice } from "./inbox-send.ts";

export const Model = Schema.Struct({
  anchor: Schema.NullOr(MailMessageId),
  target: Schema.NullOr(MailMessageId),
  text: Schema.String,
  request: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  notice: Schema.NullOr(Schema.String),
});
type Model = typeof Model.Type;

export const initial: Model = {
  anchor: null,
  target: null,
  text: "",
  request: null,
  error: null,
  notice: null,
};

export const Message = defineMessageUnion({
  Edited: { anchor: MailMessageId, latest: MailMessageId, text: Schema.String },
  Submitted: { anchor: MailMessageId },
  Sent: { request: Schema.String, saved: Schema.Boolean },
  Failed: { request: Schema.String, error: Schema.String },
  SessionExpired: { request: Schema.String },
});
type Message = typeof Message.Type;

const Send = Command.define("SendInlineReply", {
  args: { request: Schema.String, target: MailMessageId, reply: InlineReply },
  messages: [Message.Sent, Message.Failed, Message.SessionExpired],
  execute: ({ request, target, reply }) =>
    Effect.promise(async (signal) => {
      const result = await sendInboxRequest(
        inboxReplyApi(target),
        reply,
        signal,
      );
      switch (result._tag) {
        case "SessionExpired":
          return Message.SessionExpired({ request });
        case "Sent":
          return Message.Sent({ request, saved: result.saved });
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
    Edited: ({ anchor, latest, text }) => {
      const draft = model.anchor === anchor ? model : initial;
      if (draft.request) return { model };
      return {
        model: {
          ...draft,
          anchor,
          text,
          target: text.trim() ? (draft.target ?? latest) : null,
          error: null,
          notice: null,
        },
      };
    },
    Submitted: ({ anchor }) => {
      if (model.anchor !== anchor || model.request || !model.target)
        return { model };
      const reply = Schema.decodeUnknownOption(InlineReply)({
        text: model.text,
      });
      if (reply._tag === "None") return { model };
      const request = crypto.randomUUID();
      return {
        model: { ...model, request, error: null, notice: null },
        commands: [Send({ request, target: model.target, reply: reply.value })],
      };
    },
    Sent: ({ request, saved }) => ({
      model:
        model.request === request
          ? { ...initial, anchor: model.anchor, notice: sentNotice(saved) }
          : model,
    }),
    Failed: ({ request, error }) => ({
      model:
        model.request === request ? { ...model, request: null, error } : model,
    }),
    SessionExpired: () => ({ model }),
  });

export const view = Submodel.defineView<
  { state: Model; anchor: string; latest: string },
  Message
>(({ state, anchor, latest }, h) => {
  const draft = state.anchor === anchor ? state : initial;
  const sending = draft.request !== null;
  return h.form(
    [
      h.AriaLabel("Quick reply"),
      h.Class("inbox-inline-reply"),
      h.OnSubmit(Message.Submitted({ anchor })),
    ],
    [
      h.div(
        [h.Class("inbox-inline-reply-row")],
        [
          h.input([
            h.Type("text"),
            h.Name("text"),
            h.AriaLabel("Reply"),
            h.Placeholder("Reply..."),
            h.Autocomplete("off"),
            h.EnterKeyHint("send"),
            h.Required(true),
            h.Readonly(sending),
            h.Maxlength(inboxComposeLimits.text),
            h.Value(draft.text),
            h.OnInput((text) => Message.Edited({ anchor, latest, text })),
          ]),
          ...(draft.text.trim()
            ? [
                h.button(
                  [h.Type("submit"), h.Disabled(sending)],
                  [sending ? "Sending…" : "Send"],
                ),
              ]
            : []),
        ],
      ),
      ...(draft.target && draft.target !== latest
        ? [h.p([], ["Replying to the message you started with."])]
        : []),
      h.p([h.Role("status")], [draft.notice ?? ""]),
      h.p([h.Role("alert")], [draft.error ?? ""]),
    ],
  );
});
