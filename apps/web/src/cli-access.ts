import {
  CliToken,
  CliTokenLabel,
  CliTokenList,
  IssuedCliToken,
  cliTokensPath,
} from "@oneapp/core/cli-auth";
import { Effect, Schema } from "effect";
import { Command, Submodel, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";

export const Model = Schema.Struct({
  tokens: Schema.NullOr(CliTokenList),
  label: Schema.String,
  pending: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
type Model = typeof Model.Type;

export const initial: Model = {
  tokens: null,
  label: "",
  pending: false,
  error: null,
};

export const Message = defineMessageUnion({
  RequestedTokens: {},
  ChangedLabel: { label: Schema.String },
  SubmittedToken: {},
  RequestedRevocation: { id: Schema.String },
  LoadedTokens: { tokens: CliTokenList },
  CreatedToken: { token: CliToken },
  RevokedToken: { id: Schema.String },
  RequestFailed: { error: Schema.String },
});
type Message = typeof Message.Type;

const csrf = { "x-effect-auth-csrf": "1" };
const validLabel = Schema.is(CliTokenLabel);
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

const IssueToken = Command.define("IssueCliToken", {
  args: { label: CliTokenLabel },
  messages: [Message.CreatedToken, Message.RequestFailed],
  execute: ({ label }) =>
    Effect.tryPromise(async (signal) => {
      const dialog = document.getElementById("cli-token-dialog");
      const input = document.getElementById("issued-cli-token");
      if (
        !(dialog instanceof HTMLDialogElement) ||
        !(input instanceof HTMLTextAreaElement)
      ) {
        throw new Error("The token display is unavailable");
      }
      const response = await fetch(cliTokensPath, {
        method: "POST",
        headers: { ...csrf, "content-type": "application/json" },
        body: JSON.stringify({ label }),
        signal,
      });
      if (!response.ok) throw new Error("Could not issue CLI token");
      const { secret, token } = Schema.decodeUnknownSync(IssuedCliToken)(
        await response.json(),
      );

      // Keep the one-time secret out of the Foldkit model and message history.
      dialog.addEventListener(
        "close",
        () => {
          input.value = "";
        },
        { once: true },
      );
      input.value = secret;
      dialog.showModal();
      input.select();
      return Message.CreatedToken({ token });
    }).pipe(
      Effect.catch(
        failed(
          "Could not confirm token creation. Refresh the list before trying again.",
        ),
      ),
    ),
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
    ChangedLabel: ({ label }) => ({ model: { ...model, label } }),
    SubmittedToken: () => {
      if (model.pending) return { model };
      const label = model.label.trim();
      if (!validLabel(label))
        return {
          model: { ...model, error: "Enter a name of 1 to 60 characters." },
        };
      return {
        model: { ...model, pending: true, error: null },
        commands: [IssueToken({ label })],
      };
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
    CreatedToken: ({ token }) => ({
      model: {
        ...model,
        tokens: [token, ...(model.tokens ?? [])],
        label: "",
        pending: false,
      },
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
        ? h.button(
            [
              h.Type("button"),
              h.Disabled(model.pending),
              h.OnClick(Message.RequestedTokens()),
            ],
            [model.pending ? "Loading…" : "Manage CLI access"],
          )
        : h.div(
            [],
            [
              h.form(
                [h.Method("post"), h.OnSubmit(Message.SubmittedToken())],
                [
                  h.label([h.For("cli-label")], ["Device name"]),
                  h.input([
                    h.Id("cli-label"),
                    h.Required(true),
                    h.Maxlength(60),
                    h.Value(model.label),
                    h.Disabled(model.pending),
                    h.OnInput((label) => Message.ChangedLabel({ label })),
                  ]),
                  h.button(
                    [h.Type("submit"), h.Disabled(model.pending)],
                    ["Create CLI token"],
                  ),
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
