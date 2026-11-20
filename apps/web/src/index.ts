import {
  authorizationFromFragment,
  bitwardenSignInQuery,
} from "./bitwarden-connection.ts";
import { appName } from "@oneapp/core";
import { Link, LinkList } from "@oneapp/core/links";
import {
  avatar,
  button,
  buttonGroup,
  item,
  itemGroup,
  outlineIcon,
  plusIcon,
  trashIconPaths,
} from "@oneapp/ui";
import * as Client from "@yielded/auth/Client";
import { Effect, Option, Schema, Stream } from "effect";
import {
  Command,
  Mount,
  Navigation,
  Runtime,
  Subscription,
  Update,
  Url,
} from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import * as AccountSettings from "./account-settings.ts";
import { Account, AuthApi } from "./auth-contract.ts";
import * as CliLogin from "./cli-login.ts";
import * as ConnectedClients from "./connected-clients.ts";
import * as ExtensionAccess from "./extension-access.ts";
import * as Inbox from "./inbox.ts";
import {
  folderPath,
  mailMessagePage,
  MailRoute,
  mailRouteFor,
} from "./inbox-contract.ts";
import {
  deleteLink,
  parseLinkInput,
  readLinks,
  saveLink,
} from "./links-client.ts";
import { mcpAuthorizePath, mcpLoginQuery } from "./mcp-access-contract.ts";
import * as AppNavigation from "./navigation.ts";
import * as PasswordRecovery from "./password-recovery.ts";
import { forgotPasswordPage } from "./password-recovery-contract.ts";
import * as People from "./people.ts";
import { PeopleRoute, peopleRouteFor } from "./people-contract.ts";
import * as PeopleDirectory from "./people-directory.ts";
import { vaultPath } from "./vault-setup-contract.ts";
import * as VaultSetup from "./vault-setup.ts";
import { websiteIconHostname, websiteIconPath } from "./website-icon-host.ts";
import { workspaceDrawerMedia } from "./workspace.ts";

type Page = typeof AppNavigation.Page.Type;
const pageFor = (url: Url.Url): Page => {
  if (mailRouteFor(url.pathname)) return "mail";
  if (peopleRouteFor(url.pathname)) return "people";
  if (url.pathname === vaultPath || url.pathname === `${vaultPath}/`)
    return "vault";
  return url.pathname === "/settings" ||
    url.pathname === "/settings/" ||
    (url.pathname === "/" && Option.getOrUndefined(url.hash) === "cli-access")
    ? "settings"
    : "links";
};

const Model = Schema.Struct({
  page: AppNavigation.Page,
  navigation: AppNavigation.Model,
  account: Schema.NullOr(Account),
  sessionCheck: Schema.Literals(["checking", "failed", "resolved"]),
  accountSettings: AccountSettings.Model,
  vaultSetup: VaultSetup.Model,
  inbox: Inbox.Model,
  people: People.Model,
  mailRoute: Schema.NullOr(MailRoute),
  peopleRoute: Schema.NullOr(PeopleRoute),
  signInNotice: Schema.NullOr(Schema.String),
  links: Schema.NullOr(LinkList),
  linkUrl: Schema.String,
  deletingLink: Schema.NullOr(Schema.String),
  connectedClients: ConnectedClients.Model,
  cliLogin: Schema.NullOr(CliLogin.Model),
  extensionAccess: ExtensionAccess.Model,
  pending: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
type Model = typeof Model.Type;

const Message = defineMessageUnion({
  RequestedUrl: { request: Navigation.UrlRequest },
  ChangedUrl: { url: Url.Url },
  GotNavigationMessage: { message: AppNavigation.Message },
  NavigationFinished: {},
  RetriedSessionCheck: {},
  SessionCheckFailed: {},
  SubmittedSignIn: {},
  ClickedSignOut: {},
  LoadedAccount: { account: Schema.NullOr(Account) },
  GotAccountSettingsMessage: { message: AccountSettings.Message },
  GotVaultSetupMessage: { message: VaultSetup.Message },
  GotInboxMessage: { message: Inbox.Message },
  GotPeopleMessage: { message: People.Message },
  ChangedLinkUrl: { url: Schema.String },
  FocusedLinkInput: {},
  CompletedLinkAvatarImageMount: {},
  SubmittedLink: {},
  RequestedLinkDeletion: { id: Schema.String },
  RetriedLinks: {},
  LoadedLinks: { links: LinkList },
  SavedLink: { link: Link },
  DeletedLink: { id: Schema.String },
  GotConnectedClientsMessage: { message: ConnectedClients.Message },
  GotCliLoginMessage: { message: CliLogin.Message },
  GotExtensionAccessMessage: { message: ExtensionAccess.Message },
  RequestFailed: { error: Schema.String },
});
type Message = typeof Message.Type;

const AuthClient = Client.make(AuthApi, { baseUrl: window.location.origin });
const initialUrl = new URL(window.location.href);
const bitwardenAuthorization = authorizationFromFragment(initialUrl);
const connectingBitwarden =
  bitwardenAuthorization !== null &&
  initialUrl.searchParams.get(bitwardenSignInQuery) === "1";
const connectingMcp =
  new URL(window.location.href).searchParams.get(mcpLoginQuery) === "1";
const savedAtFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const toAccountSettingsMessage = (
  message: typeof AccountSettings.Message.Type,
) => Message.GotAccountSettingsMessage({ message });
const toVaultSetupMessage = (message: typeof VaultSetup.Message.Type) =>
  Message.GotVaultSetupMessage({ message });
const foldVaultSetup = Update.foldChild({
  update: VaultSetup.update,
  read: (model: Model) =>
    model.account ? Option.some(model.vaultSetup) : Option.none(),
  write: (model, vaultSetup) => ({ ...model, vaultSetup }),
  toParentMessage: toVaultSetupMessage,
});
const toInboxMessage = (message: typeof Inbox.Message.Type) =>
  Message.GotInboxMessage({ message });
const foldInbox = Update.foldChild({
  update: Inbox.update,
  read: (model: Model) =>
    model.account ? Option.some(model.inbox) : Option.none(),
  write: (model, inbox) => ({ ...model, inbox }),
  toParentMessage: toInboxMessage,
});
const toNavigationMessage = (message: typeof AppNavigation.Message.Type) =>
  Message.GotNavigationMessage({ message });
const foldNavigation = Update.foldChild({
  update: AppNavigation.update,
  read: (model: Model) => Option.some(model.navigation),
  write: (model, navigation) => ({ ...model, navigation }),
  toParentMessage: toNavigationMessage,
});
const toPeopleMessage = (message: typeof People.Message.Type) =>
  Message.GotPeopleMessage({ message });
const foldPeople = Update.foldChild({
  update: People.update,
  read: (model: Model) =>
    model.account ? Option.some(model.people) : Option.none(),
  write: (model, people) => ({ ...model, people }),
  toParentMessage: toPeopleMessage,
});
const toConnectedClientsMessage = (
  message: typeof ConnectedClients.Message.Type,
) => Message.GotConnectedClientsMessage({ message });
const foldConnectedClients = Update.foldChild({
  update: ConnectedClients.update,
  read: (model: Model) =>
    model.account ? Option.some(model.connectedClients) : Option.none(),
  write: (model, connectedClients) => ({ ...model, connectedClients }),
  toParentMessage: toConnectedClientsMessage,
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

const Navigate = Command.define("Navigate", {
  args: {
    href: Schema.String,
    mode: Schema.Literals(["push", "replace", "load"]),
  },
  messages: [Message.NavigationFinished],
  execute: ({ href, mode }) => {
    const navigate = {
      push: Navigation.pushUrl,
      replace: Navigation.replaceUrl,
      load: Navigation.load,
    }[mode];
    return navigate(href).pipe(Effect.as(Message.NavigationFinished()));
  },
});

const canonicalMailNavigation = (url: Url.Url, route: Model["mailRoute"]) => {
  if (!route?.id) return;
  const pathname = mailMessagePage(route.folder, route.id);
  if (url.pathname !== pathname) {
    return Navigate({
      href: Url.toString({ ...url, pathname }),
      mode: "replace",
    });
  }
};

const readAccount = Effect.tryPromise(async () => {
  const response = await fetch("/api/me", { cache: "no-store" });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Account request failed");
  return Schema.decodeUnknownSync(Account)(await response.json());
});

const LoadAccount = Command.define("LoadAccount", {
  args: {},
  messages: [Message.LoadedAccount, Message.SessionCheckFailed],
  execute: () =>
    readAccount.pipe(
      Effect.map((account) => Message.LoadedAccount({ account })),
      Effect.catch(() => Effect.succeed(Message.SessionCheckFailed())),
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
      if (account && connectingMcp) window.location.replace(mcpAuthorizePath);
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

const FocusLinkInput = Mount.define("FocusLinkInput", {
  messages: [Message.FocusedLinkInput],
  execute: ({ element }) =>
    Effect.sync(() => {
      if (element instanceof HTMLInputElement)
        element.focus({ preventScroll: true });
      return Message.FocusedLinkInput();
    }),
});

const DeleteLink = Command.define("DeleteLink", {
  args: { id: Schema.String },
  messages: [Message.DeletedLink, Message.LoadedAccount, Message.RequestFailed],
  execute: ({ id }) =>
    deleteLink(id).pipe(
      Effect.map((deleted) =>
        deleted
          ? Message.DeletedLink({ id })
          : Message.LoadedAccount({ account: null }),
      ),
      Effect.catch(() =>
        Effect.succeed(
          Message.RequestFailed({
            error: "Could not delete the link. Try again.",
          }),
        ),
      ),
    ),
});

const isApproval = (model: Model) =>
  connectingMcp ||
  model.cliLogin !== null ||
  model.extensionAccess.approvalId !== null ||
  model.extensionAccess.approved;

const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  folderSheet: entry(
    { open: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        open: model.inbox.folderSheet.isOpen,
      }),
      dependenciesToStream: ({ open }) =>
        open
          ? Stream.fromEventListener<MediaQueryListEvent>(
              matchMedia(workspaceDrawerMedia),
              "change",
            ).pipe(
              Stream.filter((event) => !event.matches),
              Stream.map(() => toInboxMessage(Inbox.closeFolderSheet())),
            )
          : Stream.empty,
    },
  ),
  inbox: entry(
    { active: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        active: model.account !== null && !isApproval(model),
      }),
      dependenciesToStream: ({ active }) =>
        active ? Inbox.changes.pipe(Stream.map(toInboxMessage)) : Stream.empty,
    },
  ),
}));

const loadPage = (
  model: Model,
  previousPage?: Page,
): Update.Return<Model, Message> => {
  if (!model.account || isApproval(model)) return { model };
  if (model.page === "links") {
    return model.pending || model.links !== null
      ? { model }
      : {
          model: { ...model, pending: true, error: null },
          commands: [LoadLinks({})],
        };
  }
  if (model.page === "vault")
    return foldVaultSetup(model, VaultSetup.Message.Requested());
  if (model.mailRoute)
    return foldInbox(model, Inbox.Message.Opened(model.mailRoute));
  if (model.peopleRoute)
    return foldPeople(
      model,
      People.Message.VisitedDirectory({
        id: model.peopleRoute.id,
        refresh: previousPage !== "people",
      }),
    );
  const profile = foldPeople(model, People.Message.RequestedSelf());
  const clients = foldConnectedClients(
    profile.model,
    ConnectedClients.Message.Requested(),
  );
  return {
    model: clients.model,
    commands: [...(profile.commands ?? []), ...(clients.commands ?? [])],
  };
};

const init: Runtime.RoutingApplicationInit<Model, Message> = (url) => {
  const page = pageFor(url);
  const model: Model = {
    page,
    navigation: AppNavigation.initial,
    account: null,
    sessionCheck: "checking",
    accountSettings: AccountSettings.initial,
    vaultSetup: VaultSetup.initial,
    inbox: Inbox.initial,
    people: People.initial,
    mailRoute: mailRouteFor(url.pathname),
    peopleRoute: peopleRouteFor(url.pathname),
    signInNotice: null,
    links: null,
    linkUrl: "",
    deletingLink: null,
    connectedClients: ConnectedClients.initial,
    cliLogin: CliLogin.initial(),
    extensionAccess: ExtensionAccess.initial(),
    pending: false,
    error: null,
  };
  const commands: NonNullable<
    Update.Return<Model, Message>["commands"]
  >[number][] = [LoadAccount({})];
  const mailNavigation = canonicalMailNavigation(url, model.mailRoute);
  if (mailNavigation) commands.push(mailNavigation);
  if (url.pathname === "/" && !connectingBitwarden && !isApproval(model)) {
    const hash = Option.getOrUndefined(url.hash);
    commands.push(
      Navigate({ href: `/${page}${hash ? "#" + hash : ""}`, mode: "replace" }),
    );
  }
  return { model, commands };
};

const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    RequestedUrl: ({ request }) => {
      if (
        request._tag === "Internal" &&
        !isApproval(model) &&
        (request.url.pathname === "/links" ||
          request.url.pathname === "/settings" ||
          request.url.pathname === vaultPath ||
          mailRouteFor(request.url.pathname) ||
          peopleRouteFor(request.url.pathname))
      ) {
        const from = foldInbox(model, Inbox.closeFolderSheet());
        if (request.url.pathname === window.location.pathname) return from;
        return {
          model: from.model,
          commands: [
            ...(from.commands ?? []),
            Navigate({ href: Url.toString(request.url), mode: "push" }),
          ],
        };
      }
      const href =
        request._tag === "Internal" ? Url.toString(request.url) : request.href;
      return { model, commands: [Navigate({ href, mode: "load" })] };
    },
    ChangedUrl: ({ url }) => {
      const page = pageFor(url);
      const mailRoute = mailRouteFor(url.pathname);
      const peopleRoute = peopleRouteFor(url.pathname);
      const sameRoute =
        page === model.page &&
        mailRoute?.folder === model.mailRoute?.folder &&
        mailRoute?.id === model.mailRoute?.id &&
        peopleRoute?.id === model.peopleRoute?.id;
      const result = sameRoute
        ? { model }
        : Update.combine(model, [
            foldInbox(Inbox.closeFolderSheet()),
            (next) =>
              loadPage(
                { ...next, page, mailRoute, peopleRoute, error: null },
                model.page,
              ),
          ]);
      const mailNavigation = canonicalMailNavigation(url, mailRoute);
      return mailNavigation
        ? { ...result, commands: [...(result.commands ?? []), mailNavigation] }
        : result;
    },
    GotNavigationMessage: ({ message }) => foldNavigation(model, message),
    NavigationFinished: () => ({ model }),
    RetriedSessionCheck: () =>
      model.sessionCheck === "failed"
        ? {
            model: { ...model, sessionCheck: "checking" },
            commands: [LoadAccount({})],
          }
        : { model },
    SessionCheckFailed: () => ({ model: { ...model, sessionCheck: "failed" } }),
    SubmittedSignIn: () =>
      model.sessionCheck !== "resolved" || model.pending
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
        page: model.page,
        navigation: AppNavigation.initial,
        account,
        sessionCheck: "resolved",
        accountSettings: AccountSettings.initial,
        vaultSetup: VaultSetup.initial,
        inbox: Inbox.initial,
        people: People.initial,
        mailRoute: model.mailRoute,
        peopleRoute: model.peopleRoute,
        signInNotice: null,
        links: null,
        linkUrl: "",
        deletingLink: null,
        connectedClients: ConnectedClients.initial,
        cliLogin,
        extensionAccess: ExtensionAccess.initial(),
        pending: false,
        error: null,
      };
      if (account && connectingBitwarden)
        return {
          model: next,
          commands: [Navigate({ href: bitwardenAuthorization, mode: "load" })],
        };
      if (account && cliLogin)
        return foldCliLogin(next, CliLogin.Message.Requested());
      const result = loadPage(next);
      if (!account || isApproval(next)) return result;
      const unread = foldInbox(result.model, Inbox.Message.RefreshedUnread());
      return {
        model: unread.model,
        commands: [...(result.commands ?? []), ...(unread.commands ?? [])],
      };
    },
    GotAccountSettingsMessage: ({ message }) => {
      const account = model.account;
      if (!account) return { model };
      const settings = model.accountSettings;
      const focusAccountElement = (selector: string) =>
        Command.mapMessage(
          AccountSettings.FocusElement({ selector }),
          toAccountSettingsMessage,
        );
      const start = (
        pending: NonNullable<typeof settings.pending>,
        command: NonNullable<Update.Return<Model, Message>["commands"]>[number],
      ) =>
        model.pending || settings.pending
          ? { model }
          : {
              model: {
                ...model,
                accountSettings: { ...settings, pending, error: "" },
              },
              commands: [command],
            };
      const verified = () => ({
        model: {
          ...model,
          account: { ...account, emailVerified: true },
          accountSettings: AccountSettings.initial,
        },
      });
      const signedOut = (notice: string | null) => {
        const result = update(model, Message.LoadedAccount({ account: null }));
        return {
          ...result,
          model: { ...result.model, signInNotice: notice },
        };
      };
      return AccountSettings.Message.match<Update.Return<Model, Message>>(
        message,
        {
          SendCode: () =>
            start(
              "send",
              Command.mapMessage(
                AccountSettings.SendCode({}),
                toAccountSettingsMessage,
              ),
            ),
          VerifyCode: () =>
            settings.verification
              ? start(
                  "verify",
                  Command.mapMessage(
                    AccountSettings.VerifyCode({
                      verification: settings.verification,
                    }),
                    toAccountSettingsMessage,
                  ),
                )
              : { model },
          ChangePassword: () =>
            settings.dialog === "password"
              ? start(
                  "password",
                  Command.mapMessage(
                    AccountSettings.ChangePassword({}),
                    toAccountSettingsMessage,
                  ),
                )
              : { model },
          CodeSent: ({ verification }) =>
            verification
              ? {
                  model: {
                    ...model,
                    accountSettings: {
                      ...settings,
                      pending: null,
                      verification,
                    },
                  },
                }
              : verified(),
          EmailVerified: verified,
          PasswordChanged: () =>
            signedOut("Password changed. Sign in with your new password."),
          OpenDialog: ({ dialog }) =>
            model.pending ||
            settings.pending ||
            (dialog === "email" && !account.emailDeliveryEnabled)
              ? { model }
              : {
                  model: {
                    ...model,
                    accountSettings: {
                      ...settings,
                      dialog,
                      emailChange: null,
                      error: "",
                    },
                  },
                  ...(dialog === "email" && settings.dialog === "email"
                    ? { commands: [focusAccountElement("#new-email")] }
                    : {}),
                },
          CloseDialog: () =>
            settings.dialog && !model.pending && !settings.pending
              ? {
                  model: {
                    ...model,
                    accountSettings: {
                      ...settings,
                      dialog: null,
                      emailChange: null,
                      error: "",
                    },
                  },
                  commands: [
                    focusAccountElement(`#open-${settings.dialog}-dialog`),
                  ],
                }
              : { model },
          DialogUpdated: () => ({ model }),
          SubmitEmailChange: () =>
            settings.dialog === "email" && !settings.emailChange
              ? start(
                  "send-email-change",
                  Command.mapMessage(
                    AccountSettings.SubmitEmailChange({}),
                    toAccountSettingsMessage,
                  ),
                )
              : { model },
          ConfirmEmailChange: () =>
            settings.dialog === "email" && settings.emailChange
              ? start(
                  "confirm-email-change",
                  Command.mapMessage(
                    AccountSettings.ConfirmEmailChange({
                      id: settings.emailChange.id,
                    }),
                    toAccountSettingsMessage,
                  ),
                )
              : { model },
          EmailChangeStarted: ({ change }) => ({
            model: {
              ...model,
              accountSettings: {
                ...settings,
                pending: null,
                emailChange: change,
              },
            },
            commands: [focusAccountElement("#email-change-code")],
          }),
          EmailChanged: ({ oldAddressNotified }) =>
            signedOut(
              oldAddressNotified
                ? "Email changed. Sign in with your new address."
                : "Email changed. Sign in with your new address. OneApp could not send the notice to your old address.",
            ),
          SignedOut: () => signedOut(null),
          Failed: ({ error }) => ({
            model: {
              ...model,
              accountSettings: { ...settings, pending: null, error },
            },
          }),
        },
      );
    },
    ChangedLinkUrl: ({ url }) => ({ model: { ...model, linkUrl: url } }),
    FocusedLinkInput: () => ({ model }),
    CompletedLinkAvatarImageMount: () => ({ model }),
    SubmittedLink: () => {
      if (model.pending || !model.account || !model.links) return { model };
      const input = parseLinkInput(model.linkUrl);
      if (!input) {
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
    RequestedLinkDeletion: ({ id }) =>
      model.pending ||
      !model.account ||
      !model.links?.some((link) => link.id === id)
        ? { model }
        : {
            model: { ...model, pending: true, deletingLink: id, error: null },
            commands: [DeleteLink({ id })],
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
    DeletedLink: ({ id }) => ({
      model: {
        ...model,
        links: model.links?.filter((link) => link.id !== id) ?? null,
        deletingLink: null,
        pending: false,
      },
    }),
    RequestFailed: ({ error }) => ({
      model: { ...model, deletingLink: null, pending: false, error },
    }),
    GotVaultSetupMessage: ({ message }) => foldVaultSetup(model, message),
    GotPeopleMessage: ({ message }) => {
      const { selfRequest, loadRequest, saveRequest, directory } = model.people;
      if (
        message._tag === "SessionExpired" &&
        [
          selfRequest,
          loadRequest,
          saveRequest,
          directory.listRequest,
          directory.editRequest,
        ].includes(message.request)
      )
        return update(model, Message.LoadedAccount({ account: null }));
      const result = foldPeople(model, message);
      if (
        message._tag !== "Saved" ||
        (message.request !== saveRequest &&
          message.request !== directory.editRequest) ||
        model.page !== "mail"
      )
        return result;
      const inbox = foldInbox(result.model, Inbox.Message.UpdatedProfiles());
      return {
        model: inbox.model,
        commands: [...(result.commands ?? []), ...(inbox.commands ?? [])],
      };
    },
    GotInboxMessage: ({ message }) => {
      if (message._tag === "RequestedPerson")
        return foldPeople(
          model,
          People.Message.Opened({
            address: message.address,
            suggestedName: message.name,
          }),
        );
      if (message._tag === "LiveChanged" && model.page !== "mail")
        return foldInbox(model, Inbox.Message.RefreshedUnread());
      if (
        message._tag === "RequestedBack" &&
        model.account &&
        model.mailRoute?.id
      ) {
        return {
          model,
          commands: [
            Navigate({
              href: folderPath(model.mailRoute.folder),
              mode: "push",
            }),
          ],
        };
      }
      const deleting = model.inbox.deleteRequest;
      const moving = model.inbox.archiveRequest;
      if (
        message._tag === "SessionExpired" &&
        (message.request === model.inbox.listRequest?.id ||
          message.request === model.inbox.entryRequest ||
          message.request === model.inbox.threadRequest ||
          message.request === model.inbox.unreadRequest ||
          Object.values(model.inbox.readRequests).includes(message.request) ||
          message.request === model.inbox.compose.request ||
          message.request === model.inbox.quickReply.request ||
          message.request === model.inbox.attachmentPreview?.request ||
          message.request === deleting?.request ||
          message.request === moving?.request)
      ) {
        return update(model, Message.LoadedAccount({ account: null }));
      }
      const result = foldInbox(model, message);
      if (
        message._tag === "ArchiveChanged" &&
        moving?.request === message.request &&
        moving.selected &&
        moving.folder === (moving.archived ? "inbox" : "archive") &&
        model.mailRoute?.folder === moving.folder &&
        model.mailRoute.id === moving.selected
      ) {
        const items = model.inbox.list?.messages ?? [];
        const index = items.findIndex(
          ({ id }) => id === moving.id || id === moving.selected,
        );
        const next =
          index === -1 ? undefined : (items[index + 1] ?? items[index - 1]);
        return {
          ...result,
          commands: [
            ...(result.commands ?? []),
            Navigate({
              href: next
                ? mailMessagePage(moving.folder, next.id)
                : folderPath(moving.folder),
              mode: "replace",
            }),
          ],
        };
      }
      if (
        message._tag === "DeletedEntry" &&
        deleting?.request === message.request &&
        model.mailRoute &&
        model.mailRoute.id === message.id
      ) {
        return {
          ...result,
          commands: [
            ...(result.commands ?? []),
            Navigate({
              href: folderPath(model.mailRoute.folder),
              mode: "replace",
            }),
          ],
        };
      }
      return result;
    },
    GotConnectedClientsMessage: ({ message }) =>
      foldConnectedClients(model, message),
    GotCliLoginMessage: ({ message }) => foldCliLogin(model, message),
    GotExtensionAccessMessage: ({ message }) =>
      foldExtensionAccess(model, message),
  });

const savedLinkAvatar = (url: string, h: HtmlBuilder<Message>) => {
  const hostname = websiteIconHostname(url);
  return avatar(
    {
      src: hostname ? websiteIconPath(hostname) : null,
      imageMounted: Message.CompletedLinkAvatarImageMount(),
      fallback: h.svg(
        [
          h.ViewBox("0 0 24 24"),
          h.Width("18"),
          h.Height("18"),
          h.Fill("none"),
          h.Stroke("currentColor"),
          h.StrokeWidth("1.75"),
          h.StrokeLinecap("round"),
        ],
        [
          h.path([h.D("M10 13a4 4 0 0 0 6 .4l4-4a4 4 0 0 0-5.7-5.7L12 6")], []),
          h.path(
            [h.D("M14 11a4 4 0 0 0-6-.4l-4 4a4 4 0 0 0 5.7 5.7L12 18")],
            [],
          ),
        ],
      ),
    },
    h,
  );
};

const linksView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [h.Class("links")],
    [
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
                buttonGroup(
                  [
                    h.input([
                      h.Id("link-url"),
                      h.Type("text"),
                      h.InputMode("url"),
                      h.Autocapitalize("off"),
                      h.Spellcheck(false),
                      h.AriaLabel("Link URL"),
                      h.Placeholder("Paste a URL"),
                      h.EnterKeyHint("done"),
                      h.Required(true),
                      h.Value(model.linkUrl),
                      h.Readonly(model.pending),
                      h.OnMount(FocusLinkInput()),
                      h.OnInput((url) => Message.ChangedLinkUrl({ url })),
                    ]),
                    button(
                      {
                        type: "submit",
                        variant: "outline",
                        size: "icon",
                        ariaLabel: "Save link",
                        disabled:
                          model.pending || !parseLinkInput(model.linkUrl),
                        children: [plusIcon(h, "18")],
                      },
                      h,
                    ),
                  ],
                  h,
                ),
                h.p(
                  [h.Role("status")],
                  [
                    model.deletingLink !== null
                      ? "Deleting link…"
                      : model.pending
                        ? "Saving…"
                        : "",
                  ],
                ),
              ],
            ),
            model.links.length === 0
              ? h.p([], ["No saved links yet."])
              : itemGroup(
                  model.links.map((link) =>
                    item(
                      {
                        key: link.id,
                        href: link.url,
                        target: "_blank",
                        media: savedLinkAvatar(link.url, h),
                        title: link.url.replace(/^https?:\/\//i, ""),
                        description: h.time(
                          [h.Datetime(new Date(link.savedAt).toISOString())],
                          [savedAtFormat.format(link.savedAt)],
                        ),
                        action: button(
                          {
                            variant: "ghost",
                            size: "icon",
                            rounded: true,
                            ariaLabel: `Delete ${link.url}`,
                            disabled: model.pending,
                            onClick: Message.RequestedLinkDeletion({
                              id: link.id,
                            }),
                            children: [outlineIcon(h, trashIconPaths)],
                          },
                          h,
                        ),
                      },
                      h,
                    ),
                  ),
                  h,
                ),
          ]),
    ],
  );

const settingsView = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("settings")],
    [
      h.section(
        [h.Class("settings-profile")],
        [
          h.h2([], ["Profile"]),
          h.div(
            [h.Class("settings-profile-row")],
            [
              People.avatar(
                h,
                model.people.self,
                model.people.self?.managedAddresses[0] ?? "",
              ),
              ...(model.people.self?.name
                ? [h.strong([], [model.people.self.name])]
                : []),
              h.button(
                [
                  h.Type("button"),
                  h.OnClick(
                    toPeopleMessage(People.Message.Opened({ address: null })),
                  ),
                ],
                ["Edit profile"],
              ),
            ],
          ),
        ],
      ),
      h.section(
        [h.Class("settings-account")],
        [
          h.h2([], ["Account"]),
          ...(model.account
            ? AccountSettings.view(
                model.account,
                model.accountSettings,
                model.pending,
                h,
                toAccountSettingsMessage,
                h.button(
                  [
                    h.Type("button"),
                    h.Disabled(
                      model.pending ||
                        model.accountSettings.pending !== null ||
                        model.connectedClients.pending,
                    ),
                    h.OnClick(Message.ClickedSignOut()),
                  ],
                  ["Sign out"],
                ),
              )
            : []),
        ],
      ),
      h.submodel({
        slotId: "connected-clients",
        view: ConnectedClients.view,
        model: model.connectedClients,
        toParentMessage: toConnectedClientsMessage,
      }),
    ],
  );

const signInView = (model: Model, h: HtmlBuilder<Message>) =>
  h.form(
    [h.Id("sign-in"), h.Method("post"), h.OnSubmit(Message.SubmittedSignIn())],
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
      h.button([h.Type("submit"), h.Disabled(model.pending)], ["Sign in"]),
      h.a([h.Href(forgotPasswordPage)], ["Forgot password?"]),
    ],
  );

const approvalView = (model: Model, h: HtmlBuilder<Message>) => {
  if (connectingMcp)
    return h.a([h.Href(mcpAuthorizePath)], ["Continue to MCP approval"]);
  if (model.cliLogin)
    return h.submodel({
      slotId: "cli-login",
      view: CliLogin.view,
      model: model.cliLogin,
      toParentMessage: toCliLoginMessage,
    });
  return h.submodel({
    slotId: "extension-access",
    view: ExtensionAccess.view,
    model: model.extensionAccess,
    toParentMessage: toExtensionAccessMessage,
  });
};

const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  if (model.sessionCheck !== "resolved") {
    return {
      title: appName,
      body: h.main(
        [h.Class("standalone")],
        [
          h.h1([], [appName]),
          ...(model.sessionCheck === "checking"
            ? [h.p([h.Role("status")], ["Checking your session…"])]
            : [
                h.p([h.Role("alert")], ["Could not check your session."]),
                h.button(
                  [h.Type("button"), h.OnClick(Message.RetriedSessionCheck())],
                  ["Retry"],
                ),
              ]),
        ],
      ),
    };
  }
  const error = h.p([h.Role("alert")], [model.error ?? ""]);
  if (!model.account || isApproval(model)) {
    return {
      title: appName,
      body: h.main(
        [h.Class("standalone")],
        [
          h.h1([], [appName]),
          ...(connectingBitwarden && !model.account
            ? [h.p([], ["Sign in to connect Bitwarden to OneApp."])]
            : []),
          ...(connectingMcp && !model.account
            ? [h.p([], ["Sign in to connect Codex to OneApp."])]
            : []),
          ...(model.signInNotice
            ? [h.p([h.Role("status")], [model.signInNotice])]
            : []),
          model.account ? approvalView(model, h) : signInView(model, h),
          error,
        ],
      ),
    };
  }
  const title = {
    links: "Links",
    mail: "Mail",
    vault: "Vault",
    people: "People",
    settings: "Settings",
  }[model.page];
  const usesOwnHeading =
    model.page === "links" ||
    model.page === "mail" ||
    model.page === "people" ||
    (model.page === "vault" && model.vaultSetup.status?.initialized === true);
  return {
    title: `${title} · ${appName}`,
    body: h.div(
      [h.Class("app-shell")],
      [
        AppNavigation.navigationView(
          model.page,
          model.inbox.unreadCount,
          model.navigation,
          toNavigationMessage,
          h,
        ),
        h.main(
          [h.Class("page"), ...(usesOwnHeading ? [h.AriaLabel(title)] : [])],
          [
            ...(usesOwnHeading ? [] : [h.h1([], [title])]),
            {
              links: () => linksView(model, h),
              mail: () =>
                h.submodel({
                  slotId: "inbox",
                  view: Inbox.view,
                  model: model.inbox,
                  toParentMessage: toInboxMessage,
                }),
              vault: () =>
                h.submodel({
                  slotId: "vault-setup",
                  view: VaultSetup.view,
                  model: model.vaultSetup,
                  toParentMessage: toVaultSetupMessage,
                }),
              people: () =>
                h.submodel({
                  slotId: "people-directory",
                  view: PeopleDirectory.view,
                  model: model.people.directory,
                  toParentMessage: toPeopleMessage,
                }),
              settings: () => settingsView(model, h),
            }[model.page](),
            error,
          ],
        ),
        h.submodel({
          slotId: "person-editor",
          view: People.view,
          model: model.people,
          toParentMessage: toPeopleMessage,
        }),
      ],
    ),
  };
};

if (bitwardenAuthorization && !connectingBitwarden) {
  window.location.replace(bitwardenAuthorization);
} else if (PasswordRecovery.isRecoveryPage(window.location.pathname)) {
  PasswordRecovery.run(window.location.pathname);
} else
  Runtime.run(
    Runtime.makeApplication({
      Model,
      init,
      update,
      view,
      subscriptions,
      routing: {
        onUrlRequest: (request) => Message.RequestedUrl({ request }),
        onUrlChange: (url) => Message.ChangedUrl({ url }),
      },
      container: document.getElementById("root"),
    }),
  );
