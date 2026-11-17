import { CliTokenList, cliTokensPath } from "@oneapp/core/cli-auth";
import { Effect, Schema } from "effect";
import { Command, Submodel, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";

export const Model = Schema.Struct({
  tokens: Schema.NullOr(CliTokenList),
  pending: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
type Model = typeof Model.Type;

export const initial: Model = {
  tokens: null,
  pending: false,
  error: null,
};

export const Message = defineMessageUnion({
  RequestedTokens: {},
  RequestedRevocation: { id: Schema.String },
  LoadedTokens: { tokens: CliTokenList },
  RevokedToken: { id: Schema.String },
  RequestFailed: { error: Schema.String },
});
type Message = typeof Message.Type;

const csrf = { "x-effect-auth-csrf": "1" };
const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const failed = (error: string) => () =>
  Effect.succeed(Message.RequestFailed({ error }));

const LoadTokens = Command.define("LoadCliTokens", {
  args: {},
  messages: [Message.LoadedTokens, Message.RequestFailed],
  execute: () =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(cliTokensPath, {
        signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not load CLI tokens");
      return Message.LoadedTokens({
        tokens: Schema.decodeUnknownSync(CliTokenList)(await response.json()),
      });
    }).pipe(Effect.catch(failed("Could not load CLI access. Try again."))),
});

const RevokeToken = Command.define("RevokeCliToken", {
  args: { id: Schema.String },
  messages: [Message.RevokedToken, Message.RequestFailed],
  execute: ({ id }) =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(
        `${cliTokensPath}/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: csrf,
          signal,
        },
      );
      if (!response.ok) throw new Error("Could not revoke CLI token");
      return Message.RevokedToken({ id });
    }).pipe(Effect.catch(failed("Could not revoke the token. Try again."))),
});

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    RequestedTokens: () =>
      model.pending
        ? { model }
        : {
            model: { ...model, pending: true, error: null },
            commands: [LoadTokens({})],
          },
    RequestedRevocation: ({ id }) =>
      model.pending
        ? { model }
        : {
            model: { ...model, pending: true, error: null },
            commands: [RevokeToken({ id })],
          },
    LoadedTokens: ({ tokens }) => ({
      model: { ...model, tokens, pending: false },
    }),
    RevokedToken: ({ id }) => ({
      model: {
        ...model,
        tokens: model.tokens?.filter((token) => token.id !== id) ?? null,
        pending: false,
      },
    }),
    RequestFailed: ({ error }) => ({
      model: { ...model, pending: false, error },
    }),
  });

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.section(
    [h.Id("cli-access")],
    [
      h.h2([], ["CLI access"]),
      model.tokens === null
        ? model.error
          ? h.button(
              [h.Type("button"), h.OnClick(Message.RequestedTokens())],
              ["Retry loading CLI access"],
            )
          : h.p([h.Role("status")], ["Loading CLI access…"])
        : h.div(
            [],
            [
              h.p(
                [],
                [
                  "Run ",
                  h.code([], ["one auth login"]),
                  " to connect a device.",
                ],
              ),
              model.tokens.length === 0
                ? h.p([], ["No active CLI tokens."])
                : h.ul(
                    [h.Class("cli-tokens")],
                    model.tokens.map((token) =>
                      h.li(
                        [h.Key(token.id)],
                        [
                          h.div(
                            [],
                            [
                              h.strong([], [token.label]),
                              h.div(
                                [],
                                [
                                  token.expiresAt === null
                                    ? "Active until revoked"
                                    : `Expires ${date.format(token.expiresAt)}`,
                                ],
                              ),
                            ],
                          ),
                          h.button(
                            [
                              h.Type("button"),
                              h.AriaLabel(`Revoke ${token.label}`),
                              h.Disabled(model.pending),
                              h.OnClick(
                                Message.RequestedRevocation({ id: token.id }),
                              ),
                            ],
                            ["Revoke"],
                          ),
                        ],
                      ),
                    ),
                  ),
              ...(model.error
                ? [
                    h.button(
                      [
                        h.Type("button"),
                        h.Disabled(model.pending),
                        h.OnClick(Message.RequestedTokens()),
                      ],
                      ["Refresh tokens"],
                    ),
                  ]
                : []),
            ],
          ),
      h.p([h.Role("alert")], [model.error ?? ""]),
    ],
  ),
);
