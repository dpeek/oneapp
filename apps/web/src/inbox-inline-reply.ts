import { Effect, Schema } from "effect";
import { Command, Submodel, Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { mailEditor } from "./mail-editor-contract.ts";
import {
  InboxMessageId,
  inboxReplyApi,
  InlineReply,
  MailMessageId,
} from "./inbox-contract.ts";
import { sendInboxRequest, SentConfirmation } from "./inbox-send.ts";

export const Model = Schema.Struct({
  anchor: Schema.NullOr(MailMessageId),
  target: Schema.NullOr(MailMessageId),
  completeThrough: Schema.NullOr(InboxMessageId),
  text: Schema.String,
  html: Schema.optional(Schema.String),
  request: Schema.NullOr(Schema.String),
});
type Model = typeof Model.Type;

export const initial: Model = {
  anchor: null,
  target: null,
  completeThrough: null,
  text: "",
  request: null,
};

export const Message = defineMessageUnion({
  Edited: {
    anchor: MailMessageId,
    latest: MailMessageId,
    latestIncoming: Schema.NullOr(InboxMessageId),
    text: Schema.String,
    html: Schema.optionalKey(Schema.String),
  },
  Submitted: { anchor: MailMessageId },
  Sent: { request: Schema.String, ...SentConfirmation },
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
    Edited: ({ anchor, latest, latestIncoming, text, html }) => {
      const draft = model.anchor === anchor ? model : initial;
      if (draft.request) return { model };
      const target = text.trim() ? (draft.target ?? latest) : null;
      return {
        model: {
          ...draft,
          anchor,
          text,
          html,
          target,
          completeThrough: target
            ? draft.target
              ? draft.completeThrough
              : latestIncoming
            : null,
        },
      };
    },
    Submitted: ({ anchor }) => {
      if (model.anchor !== anchor || model.request || !model.target)
        return { model };
      const reply = Schema.decodeUnknownOption(InlineReply)({
        text: model.text,
        ...(model.html !== undefined ? { html: model.html } : {}),
        ...(model.completeThrough
          ? { completeThrough: model.completeThrough }
          : {}),
      });
      if (reply._tag === "None") return { model };
      const request = crypto.randomUUID();
      return {
        model: { ...model, request },
        commands: [Send({ request, target: model.target, reply: reply.value })],
      };
    },
    Sent: ({ request }) => ({
      model: model.request === request ? initial : model,
    }),
    Failed: ({ request }) => ({
      model: model.request === request ? { ...model, request: null } : model,
    }),
    SessionExpired: () => ({ model }),
  });

export const view = Submodel.defineView<
  {
    state: Model;
    anchor: string;
    latest: string;
    latestIncoming: string | null;
  },
  Message
>(({ state, anchor, latest, latestIncoming }, h) => {
  const draft = state.anchor === anchor ? state : initial;
  const sending = draft.request !== null;
  const editor = mailEditor.withMessage(h);
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
          editor([
            h.Name("body"),
            h.Key(anchor),
            editor.Label("Reply"),
            editor.Compact(true),
            editor.ReadOnly(sending),
            editor.Value({
              text: draft.text,
              ...(draft.html !== undefined ? { html: draft.html } : {}),
            }),
            editor.OnBodyEdited((body) =>
              Message.Edited({ anchor, latest, latestIncoming, ...body }),
            ),
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
    ],
  );
});
