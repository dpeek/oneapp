import { appName } from "@oneapp/core";
import * as Client from "@yielded/auth/Client";
import { Effect, Schema } from "effect";
import { Command, Runtime, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { Account, AuthApi } from "./auth-contract.ts";

const Model = Schema.Struct({
  account: Schema.NullOr(Account),
  pending: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
type Model = typeof Model.Type;

const Message = defineMessageUnion({
  SubmittedSignIn: {},
  ClickedSignOut: {},
  LoadedAccount: { account: Schema.NullOr(Account) },
  AuthFailed: { error: Schema.String },
});
type Message = typeof Message.Type;

const AuthClient = Client.make(AuthApi, { baseUrl: window.location.origin });

const readAccount = Effect.tryPromise(async () => {
  const response = await fetch("/api/me", { cache: "no-store" });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Account request failed");
  return Schema.decodeUnknownSync(Account)(await response.json());
});

const LoadAccount = Command.define("LoadAccount", {
  args: {},
  messages: [Message.LoadedAccount, Message.AuthFailed],
  execute: () =>
    readAccount.pipe(
      Effect.map((account) => Message.LoadedAccount({ account })),
      Effect.catch(() =>
        Effect.succeed(
          Message.AuthFailed({
            error: "Could not load your account. Reload to retry.",
          }),
        ),
      ),
    ),
});

const SignIn = Command.define("SignIn", {
  args: {},
  messages: [Message.LoadedAccount, Message.AuthFailed],
  execute: () =>
    Effect.gen(function* () {
      const form = document.getElementById("sign-in");
      if (!(form instanceof HTMLFormElement)) {
        return Message.AuthFailed({
          error: "Could not read the sign-in form.",
        });
      }

      // Keep the password out of Foldkit messages, state, and command arguments.
      const values = new FormData(form);
      form.reset();
      const email = values.get("email");
      const password = values.get("password");
      if (typeof email !== "string" || typeof password !== "string") {
        return Message.AuthFailed({ error: "Enter your email and password." });
      }

      const client = yield* AuthClient;
      yield* client.auth.signIn({ email, password });
      const account = yield* readAccount;
      return account
        ? Message.LoadedAccount({ account })
        : Message.AuthFailed({
            error: "Could not start a session. Try again.",
          });
    }).pipe(
      Effect.provide(AuthClient.layerFetch),
      Effect.catch((error) =>
        Effect.succeed(
          Message.AuthFailed({
            error:
              error._tag === "PasswordRejected"
                ? "Email or password is incorrect."
                : "Could not sign in. Try again.",
          }),
        ),
      ),
    ),
});

const SignOut = Command.define("SignOut", {
  args: {},
  messages: [Message.LoadedAccount, Message.AuthFailed],
  execute: () =>
    Effect.gen(function* () {
      const client = yield* AuthClient;
      yield* client.auth.signOut();
      return Message.LoadedAccount({ account: null });
    }).pipe(
      Effect.provide(AuthClient.layerFetch),
      Effect.catch(() =>
        Effect.succeed(
          Message.AuthFailed({ error: "Could not sign out. Try again." }),
        ),
      ),
    ),
});

const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: { account: null, pending: true, error: null },
  commands: [LoadAccount({})],
});

const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SubmittedSignIn: () =>
      model.pending
        ? { model }
        : {
            model: { ...model, pending: true, error: null },
            commands: [SignIn({})],
          },
    ClickedSignOut: () =>
      model.pending
        ? { model }
        : {
            model: { ...model, pending: true, error: null },
            commands: [SignOut({})],
          },
    LoadedAccount: ({ account }) => ({
      model: { account, pending: false, error: null },
    }),
    AuthFailed: ({ error }) => ({ model: { ...model, pending: false, error } }),
  });

const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: appName,
  body: h.main(
    [],
    [
      h.h1([], [appName]),
      model.account
        ? h.section(
            [],
            [
              h.p([], [model.account.email]),
              h.button(
                [
                  h.Type("button"),
                  h.Disabled(model.pending),
                  h.OnClick(Message.ClickedSignOut()),
                ],
                ["Sign out"],
              ),
            ],
          )
        : h.form(
            [
              h.Id("sign-in"),
              h.Method("post"),
              h.OnSubmit(Message.SubmittedSignIn()),
            ],
            [
              h.label([h.For("email")], ["Email"]),
              h.input([
                h.Id("email"),
                h.Name("email"),
                h.Type("email"),
                h.Autocomplete("username"),
                h.Required(true),
              ]),
              h.label([h.For("password")], ["Password"]),
              h.input([
                h.Id("password"),
                h.Name("password"),
                h.Type("password"),
                h.Autocomplete("current-password"),
                h.Required(true),
              ]),
              h.button(
                [h.Type("submit"), h.Disabled(model.pending)],
                ["Sign in"],
              ),
            ],
          ),
      h.p([h.Role("alert")], [model.error ?? ""]),
    ],
  ),
});

Runtime.run(
  Runtime.makeApplication({
    Model,
    init,
    update,
    view,
    container: document.getElementById("root"),
  }),
);
