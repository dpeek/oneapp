import { appName } from "@oneapp/core";
import { Link, LinkList, SaveLink } from "@oneapp/core/links";
import * as Client from "@yielded/auth/Client";
import { Effect, Option, Schema } from "effect";
import { Command, Runtime, Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { Account, AuthApi } from "./auth-contract.ts";
import * as CliAccess from "./cli-access.ts";
import * as CliLogin from "./cli-login.ts";
import * as ExtensionAccess from "./extension-access.ts";
import { readLinks, saveLink } from "./links-client.ts";

const Model = Schema.Struct({
  account: Schema.NullOr(Account),
  links: Schema.NullOr(LinkList),
  linkUrl: Schema.String,
  cliAccess: CliAccess.Model,
  cliLogin: Schema.NullOr(CliLogin.Model),
  extensionAccess: ExtensionAccess.Model,
  pending: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
type Model = typeof Model.Type;

const Message = defineMessageUnion({
  SubmittedSignIn: {},
  ClickedSignOut: {},
  LoadedAccount: { account: Schema.NullOr(Account) },
  ChangedLinkUrl: { url: Schema.String },
  SubmittedLink: {},
  RetriedLinks: {},
  LoadedLinks: { links: LinkList },
  SavedLink: { link: Link },
  GotCliAccessMessage: { message: CliAccess.Message },
  GotCliLoginMessage: { message: CliLogin.Message },
  GotExtensionAccessMessage: { message: ExtensionAccess.Message },
  RequestFailed: { error: Schema.String },
});
type Message = typeof Message.Type;

const AuthClient = Client.make(AuthApi, { baseUrl: window.location.origin });
const savedAtFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const isSaveLink = Schema.is(SaveLink);
const toCliAccessMessage = (message: typeof CliAccess.Message.Type) =>
  Message.GotCliAccessMessage({ message });
const foldCliAccess = Update.foldChild({
  update: CliAccess.update,
  read: (model: Model) =>
    model.account ? Option.some(model.cliAccess) : Option.none(),
  write: (model, cliAccess) => ({ ...model, cliAccess }),
  toParentMessage: toCliAccessMessage,
});
const toCliLoginMessage = (message: typeof CliLogin.Message.Type) =>
  Message.GotCliLoginMessage({ message });
const foldCliLogin = Update.foldChild({
  update: CliLogin.update,
  read: (model: Model) => Option.fromNullishOr(model.cliLogin),
  write: (model, cliLogin) => ({ ...model, cliLogin }),
  toParentMessage: toCliLoginMessage,
});
const toExtensionAccessMessage = (
  message: typeof ExtensionAccess.Message.Type,
) => Message.GotExtensionAccessMessage({ message });
const foldExtensionAccess = Update.foldChild({
  update: ExtensionAccess.update,
  read: (model: Model) =>
    model.account ? Option.some(model.extensionAccess) : Option.none(),
  write: (model, extensionAccess) => ({ ...model, extensionAccess }),
  toParentMessage: toExtensionAccessMessage,
});

const readAccount = Effect.tryPromise(async () => {
  const response = await fetch("/api/me", { cache: "no-store" });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Account request failed");
  return Schema.decodeUnknownSync(Account)(await response.json());
});

const LoadAccount = Command.define("LoadAccount", {
  args: {},
  messages: [Message.LoadedAccount, Message.RequestFailed],
  execute: () =>
    readAccount.pipe(
      Effect.map((account) => Message.LoadedAccount({ account })),
      Effect.catch(() =>
        Effect.succeed(
          Message.RequestFailed({
            error: "Could not load your account. Reload to retry.",
          }),
        ),
      ),
    ),
});

const SignIn = Command.define("SignIn", {
  args: {},
  messages: [Message.LoadedAccount, Message.RequestFailed],
  execute: () =>
    Effect.gen(function* () {
      const form = document.getElementById("sign-in");
      if (!(form instanceof HTMLFormElement)) {
        return Message.RequestFailed({
          error: "Could not read the sign-in form.",
        });
      }

      // Keep the password out of Foldkit messages, state, and command arguments.
      const values = new FormData(form);
      form.reset();
      const email = values.get("email");
      const password = values.get("password");
      if (typeof email !== "string" || typeof password !== "string") {
        return Message.RequestFailed({
          error: "Enter your email and password.",
        });
      }

      const client = yield* AuthClient;
      yield* client.auth.signIn({ email, password });
      const account = yield* readAccount;
      return account
        ? Message.LoadedAccount({ account })
        : Message.RequestFailed({
            error: "Could not start a session. Try again.",
          });
    }).pipe(
      Effect.provide(AuthClient.layerFetch),
      Effect.catch((error) =>
        Effect.succeed(
          Message.RequestFailed({
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
  messages: [Message.LoadedAccount, Message.RequestFailed],
  execute: () =>
    Effect.gen(function* () {
      const client = yield* AuthClient;
      yield* client.auth.signOut();
      return Message.LoadedAccount({ account: null });
    }).pipe(
      Effect.provide(AuthClient.layerFetch),
      Effect.catch(() =>
        Effect.succeed(
          Message.RequestFailed({ error: "Could not sign out. Try again." }),
        ),
      ),
    ),
});

const LoadLinks = Command.define("LoadLinks", {
  args: {},
  messages: [Message.LoadedLinks, Message.LoadedAccount, Message.RequestFailed],
  execute: () =>
    readLinks.pipe(
      Effect.map((links) =>
        links === null
          ? Message.LoadedAccount({ account: null })
          : Message.LoadedLinks({ links }),
      ),
      Effect.catch(() =>
        Effect.succeed(
          Message.RequestFailed({ error: "Could not load links. Try again." }),
        ),
      ),
    ),
});

const StoreLink = Command.define("StoreLink", {
  args: { url: Schema.String },
  messages: [Message.SavedLink, Message.LoadedAccount, Message.RequestFailed],
  execute: ({ url }) =>
    saveLink(url).pipe(
      Effect.map((link) =>
        link === null
          ? Message.LoadedAccount({ account: null })
          : Message.SavedLink({ link }),
      ),
      Effect.catch(() =>
        Effect.succeed(
          Message.RequestFailed({
            error: "Could not confirm the save. Reload to check your links.",
          }),
        ),
      ),
    ),
});

const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    account: null,
    links: null,
    linkUrl: "",
    cliAccess: CliAccess.initial,
    cliLogin: CliLogin.initial(),
    extensionAccess: ExtensionAccess.initial(),
    pending: true,
    error: null,
  },
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
    LoadedAccount: ({ account }) => {
      const cliLogin = CliLogin.initial();
      const next: Model = {
        account,
        links: null,
        linkUrl: "",
        cliAccess: CliAccess.initial,
        cliLogin,
        extensionAccess: ExtensionAccess.initial(),
        pending: account !== null && cliLogin === null,
        error: null,
      };
      if (account && cliLogin)
        return foldCliLogin(next, CliLogin.Message.Requested());
      return { model: next, commands: account ? [LoadLinks({})] : [] };
    },
    ChangedLinkUrl: ({ url }) => ({ model: { ...model, linkUrl: url } }),
    SubmittedLink: () => {
      if (model.pending || !model.account || !model.links) return { model };
      const input = { url: model.linkUrl.trim() };
      if (!isSaveLink(input)) {
        return {
          model: {
            ...model,
            error: "Enter a valid HTTP or HTTPS URL without credentials.",
          },
        };
      }
      return {
        model: { ...model, pending: true, error: null },
        commands: [StoreLink(input)],
      };
    },
    RetriedLinks: () =>
      model.pending
        ? { model }
        : {
            model: { ...model, pending: true, error: null },
            commands: [LoadLinks({})],
          },
    LoadedLinks: ({ links }) => ({
      model: { ...model, links, pending: false, error: null },
    }),
    SavedLink: ({ link }) => ({
      model: {
        ...model,
        links: [link, ...(model.links ?? [])].sort(
          (a, b) => b.savedAt - a.savedAt || b.id.localeCompare(a.id),
        ),
        linkUrl: "",
        pending: false,
        error: null,
      },
    }),
    RequestFailed: ({ error }) => ({
      model: { ...model, pending: false, error },
    }),
    GotCliAccessMessage: ({ message }) => foldCliAccess(model, message),
    GotCliLoginMessage: ({ message }) => foldCliLogin(model, message),
    GotExtensionAccessMessage: ({ message }) =>
      foldExtensionAccess(model, message),
  });

const linksView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [h.Class("links")],
    [
      h.h2([], ["Links"]),
      ...(model.links === null
        ? [
            model.pending
              ? h.p([h.Role("status")], ["Loading links…"])
              : h.button(
                  [h.Type("button"), h.OnClick(Message.RetriedLinks())],
                  ["Retry"],
                ),
          ]
        : [
            h.form(
              [h.Method("post"), h.OnSubmit(Message.SubmittedLink())],
              [
                h.label([h.For("link-url")], ["Link URL"]),
                h.input([
                  h.Id("link-url"),
                  h.Type("url"),
                  h.Required(true),
                  h.Value(model.linkUrl),
                  h.Disabled(model.pending),
                  h.OnInput((url) => Message.ChangedLinkUrl({ url })),
                ]),
                h.button(
                  [h.Type("submit"), h.Disabled(model.pending)],
                  [model.pending ? "Saving…" : "Save link"],
                ),
              ],
            ),
            model.links.length === 0
              ? h.p([], ["No saved links yet."])
              : h.ul(
                  [h.Class("saved-links")],
                  model.links.map((link) =>
                    h.li(
                      [h.Key(link.id)],
                      [
                        h.a(
                          [
                            h.Href(link.url),
                            h.Target("_blank"),
                            h.Rel("noopener noreferrer"),
                          ],
                          [link.url],
                        ),
                        h.time(
                          [h.Datetime(new Date(link.savedAt).toISOString())],
                          [savedAtFormat.format(link.savedAt)],
                        ),
                      ],
                    ),
                  ),
                ),
          ]),
    ],
  );

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
                  h.Disabled(
                    model.pending ||
                      model.cliAccess.pending ||
                      model.extensionAccess.pending ||
                      model.cliLogin?.pending === true,
                  ),
                  h.OnClick(Message.ClickedSignOut()),
                ],
                ["Sign out"],
              ),
              ...(model.cliLogin
                ? [
                    h.submodel({
                      slotId: "cli-login",
                      view: CliLogin.view,
                      model: model.cliLogin,
                      toParentMessage: toCliLoginMessage,
                    }),
                  ]
                : [
                    ...(model.extensionAccess.approvalId
                      ? []
                      : [
                          linksView(model, h),
                          h.submodel({
                            slotId: "cli-access",
                            view: CliAccess.view,
                            model: model.cliAccess,
                            toParentMessage: toCliAccessMessage,
                          }),
                        ]),
                    h.submodel({
                      slotId: "extension-access",
                      view: ExtensionAccess.view,
                      model: model.extensionAccess,
                      toParentMessage: toExtensionAccessMessage,
                    }),
                  ]),
            ],
          )
        : h.form(
            [
              h.Id("sign-in"),
              h.Method("post"),
              h.OnSubmit(Message.SubmittedSignIn()),
            ],
            [
              ...(model.cliLogin
                ? [h.p([], ["Sign in to connect the OneApp CLI."])]
                : model.extensionAccess.approvalId
                  ? [h.p([], ["Sign in to connect the OneApp extension."])]
                  : []),
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
