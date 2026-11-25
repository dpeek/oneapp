import "./mail-editor.ts";
import * as PushSettings from "./push-settings.ts";
import {
  clearPushAfterSignOut,
  registerServiceWorker,
} from "./push-browser.ts";
import {
  authorizationFromFragment,
  bitwardenSignInQuery,
} from "./bitwarden-connection.ts";
import { appName } from "@oneapp/core";
import {
  alert,
  button,
  calendarIconPaths,
  CommandMenu,
  Dialog,
  field,
  input,
  item,
  itemGroup,
  outlineIcon,
  plusIcon,
  Sheet,
  taskIconPaths,
} from "@oneapp/ui";
import * as Client from "@yielded/auth/Client";
import { Effect, Option, Schema, Stream } from "effect";
import {
  Command,
  Navigation,
  Runtime,
  Subscription,
  Update,
  Url,
} from "foldkit";
import { focus } from "foldkit/dom";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { ThemePreference } from "./account-contract.ts";
import * as AccountSettings from "./account-settings.ts";
import { Account, AuthApi } from "./auth-contract.ts";
import * as Calendar from "./calendar.ts";
import {
  calendarListPath,
  CalendarRoute,
  calendarRouteFor,
} from "./calendar-contract.ts";
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
import * as Links from "./links.ts";
import * as Notifications from "./notifications.ts";
import { notificationView } from "./notification-view.ts";
import { mcpAuthorizePath, mcpLoginQuery } from "./mcp-access-contract.ts";
import * as AppNavigation from "./navigation.ts";
import * as PasswordRecovery from "./password-recovery.ts";
import { forgotPasswordPage } from "./password-recovery-contract.ts";
import * as People from "./people.ts";
import {
  ContactsRoute,
  contactsListPath,
  contactsRouteFor,
} from "./people-contract.ts";
import * as PeopleDirectory from "./people-directory.ts";
import {
  settingsNavigation,
  SettingsSection,
  settingsSectionFor,
  settingsSectionLabel,
  settingsSectionPath,
} from "./settings-navigation.ts";
import * as Files from "./files.ts";
import { filePath, FileRoute, fileRouteFor } from "./files-contract.ts";
import { view as filesView } from "./files-view.ts";
import * as Tasks from "./tasks.ts";
import { taskPath, TaskRoute, taskRouteFor } from "./tasks-contract.ts";
import {
  createView as taskCreateView,
  view as tasksView,
} from "./tasks-view.ts";
import { vaultPath } from "./vault-setup-contract.ts";
import * as VaultSetup from "./vault-setup.ts";
import { workspace, workspaceDrawerMedia } from "./workspace.ts";

type Page = typeof AppNavigation.Page.Type;
const pageFor = (url: Url.Url): Page => {
  if (mailRouteFor(url.pathname)) return "mail";
  if (calendarRouteFor(url.pathname)) return "calendar";
  if (taskRouteFor(url.pathname)) return "tasks";
  if (fileRouteFor(url.pathname)) return "files";
  if (contactsRouteFor(url.pathname)) return "contacts";
  if (url.pathname === vaultPath || url.pathname === `${vaultPath}/`)
    return "vault";
  return settingsSectionFor(url) ? "settings" : "links";
};

const settingsSheetId = "settings-sections";
const Model = Schema.Struct({
  page: AppNavigation.Page,
  navigation: AppNavigation.Model,
  account: Schema.NullOr(Account),
  appearance: AccountSettings.Appearance,
  sessionCheck: Schema.Literals(["checking", "failed", "resolved"]),
  accountSettings: AccountSettings.Model,
  settingsSection: Schema.NullOr(SettingsSection),
  settingsSheet: Sheet.Model,
  pushSettings: PushSettings.Model,
  vaultSetup: VaultSetup.Model,
  inbox: Inbox.Model,
  people: People.Model,
  calendar: Calendar.Model,
  calendarRoute: Schema.NullOr(CalendarRoute),
  tasks: Tasks.Model,
  files: Files.Model,
  fileRoute: Schema.NullOr(FileRoute),
  creationDialog: Dialog.Model,
  creationMenu: Schema.NullOr(CommandMenu.Model),
  taskRoute: Schema.NullOr(TaskRoute),
  mailRoute: Schema.NullOr(MailRoute),
  peopleRoute: Schema.NullOr(ContactsRoute),
  signInNotice: Schema.NullOr(Schema.String),
  links: Links.Model,
  notifications: Notifications.Model,
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
  RequestedFolderSheetClose: {},
  RetriedSessionCheck: {},
  SessionCheckFailed: {},
  SubmittedSignIn: {},
  ClickedSignOut: {},
  LoadedAccount: { account: Schema.NullOr(Account) },
  GotAppearanceMessage: { message: AccountSettings.AppearanceMessage },
  GotAccountSettingsMessage: { message: AccountSettings.Message },
  GotSettingsSheetMessage: { message: Sheet.Message },
  GotPushSettingsMessage: { message: PushSettings.Message },
  CompletedAccountSettingsRequest: {
    request: Schema.String,
    message: AccountSettings.Message,
  },
  GotVaultSetupMessage: { message: VaultSetup.Message },
  GotInboxMessage: { message: Inbox.Message },
  GotPeopleMessage: { message: People.Message },
  GotCalendarMessage: { message: Calendar.Message },
  GotTasksMessage: { message: Tasks.Message },
  GotFilesMessage: { message: Files.Message },
  OpenedCreationMenu: {},
  GotCreationDialogMessage: { message: Dialog.Message },
  FocusedCreationTitle: {},
  GotCreationMenuMessage: { message: CommandMenu.Message },
  GotLinksMessage: { message: Links.Message },
  GotNotificationMessage: { message: Notifications.Message },
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
const toAccountSettingsMessage = (
  message: typeof AccountSettings.Message.Type,
) => Message.GotAccountSettingsMessage({ message });

const toAppearanceMessage = (
  message: typeof AccountSettings.AppearanceMessage.Type,
) => Message.GotAppearanceMessage({ message });
const isThemePreference = Schema.is(ThemePreference);
const foldAccountDialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.accountSettings.modal),
  write: (model, modal) => ({
    ...model,
    accountSettings: { ...model.accountSettings, modal },
  }),
  toParentMessage: (message) =>
    toAccountSettingsMessage(
      AccountSettings.Message.GotDialogMessage({ message }),
    ),
  foldOutMessage: () => (model) => ({ model }),
});
const toSettingsSheetMessage = (message: typeof Sheet.Message.Type) =>
  Message.GotSettingsSheetMessage({ message });
const foldSettingsSheet = Update.foldChild({
  update: Sheet.update,
  read: (model: Model) => Option.some(model.settingsSheet),
  write: (model, settingsSheet) => ({ ...model, settingsSheet }),
  toParentMessage: toSettingsSheetMessage,
  foldOutMessage: () => (model) => ({ model }),
});
const toPushSettingsMessage = (message: typeof PushSettings.Message.Type) =>
  Message.GotPushSettingsMessage({ message });
const foldPushSettings = Update.foldChild({
  update: PushSettings.update,
  read: (model: Model) =>
    model.account ? Option.some(model.pushSettings) : Option.none(),
  write: (model, pushSettings) => ({ ...model, pushSettings }),
  toParentMessage: toPushSettingsMessage,
});
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
  foldOutMessage: (out: Inbox.OutMessage) => (model) =>
    applyNotification(model, out),
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
const foldPeople = (parent: Model, message: typeof People.Message.Type) =>
  Update.foldChild({
    update: (
      model: typeof People.Model.Type,
      message: typeof People.Message.Type,
    ) => People.update(model, message, parent.page === "contacts"),
    read: (model: Model) =>
      model.account ? Option.some(model.people) : Option.none(),
    write: (model, people) => ({ ...model, people }),
    toParentMessage: toPeopleMessage,
    foldOutMessage: (out: People.OutMessage) => (model) =>
      applyNotification(model, out),
  })(parent, message);
const toConnectedClientsMessage = (
  message: typeof ConnectedClients.Message.Type,
) => Message.GotConnectedClientsMessage({ message });
const foldConnectedClients = (
  parent: Model,
  message: typeof ConnectedClients.Message.Type,
) =>
  Update.foldChild({
    update: (
      model: typeof ConnectedClients.Model.Type,
      message: typeof ConnectedClients.Message.Type,
    ) =>
      ConnectedClients.update(
        model,
        message,
        parent.settingsSection === "clients",
      ),
    read: (model: Model) =>
      model.account ? Option.some(model.connectedClients) : Option.none(),
    write: (model, connectedClients) => ({ ...model, connectedClients }),
    toParentMessage: toConnectedClientsMessage,
    foldOutMessage:
      (out: ConnectedClients.OutMessage): Update.Step<Model, Message> =>
      (model) =>
        out._tag === "SessionExpired"
          ? update(model, Message.LoadedAccount({ account: null }))
          : applyNotification(model, out),
  })(parent, message);
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

const applyNotification = (
  model: Model,
  outcome: Inbox.OutMessage,
): Update.Return<Model, Message> => {
  const result =
    outcome._tag === "Notify"
      ? Notifications.show(model.notifications, outcome.notification)
      : Notifications.dismiss(model.notifications, outcome.key);
  return {
    model: { ...model, notifications: result.model },
    commands: Command.mapMessages(result.commands ?? [], toNotificationMessage),
  };
};
const toNotificationMessage = (message: Notifications.Message) =>
  Message.GotNotificationMessage({ message });
const foldNotifications = Update.foldChild({
  update: Notifications.update,
  read: (model: Model) => Option.some(model.notifications),
  write: (model, notifications) => ({ ...model, notifications }),
  toParentMessage: toNotificationMessage,
  foldOutMessage: (action: Notifications.Action) => (model) =>
    action._tag === "RestoreContact"
      ? foldPeople(
          model,
          People.Message.RequestedRestore({
            id: action.id,
            receipt: action.receipt,
            name: action.name,
          }),
        )
      : foldInbox(model, Inbox.Message.ActivatedNotification({ action })),
});
const toLinksMessage = (message: Links.Message) =>
  Message.GotLinksMessage({ message });
const foldLinks = Update.foldChild({
  update: Links.update,
  read: (model: Model) =>
    model.account ? Option.some(model.links) : Option.none(),
  write: (model, links) => ({ ...model, links }),
  toParentMessage: toLinksMessage,
  foldOutMessage:
    (out: Links.OutMessage): Update.Step<Model, Message> =>
    (model) => {
      if (out._tag === "SessionExpired")
        return update(model, Message.LoadedAccount({ account: null }));
      return applyNotification(model, out);
    },
});

const toCalendarMessage = (message: typeof Calendar.Message.Type) =>
  Message.GotCalendarMessage({ message });
const foldCalendarFeature = Update.foldChild({
  update: Calendar.update,
  read: (model: Model) =>
    model.account ? Option.some(model.calendar) : Option.none(),
  write: (model, calendar) => ({ ...model, calendar }),
  toParentMessage: toCalendarMessage,
  foldOutMessage:
    (out: Calendar.OutMessage): Update.Step<Model, Message> =>
    (model) => {
      if (out._tag === "SessionExpired")
        return update(model, Message.LoadedAccount({ account: null }));
      return model.page === "calendar"
        ? {
            model,
            commands: [
              Navigate({ href: calendarListPath(out.id), mode: "push" }),
            ],
          }
        : { model };
    },
});

const toTasksMessage = (message: Tasks.Message) =>
  Message.GotTasksMessage({ message });
const toCreationDialogMessage = (message: typeof Dialog.Message.Type) =>
  Message.GotCreationDialogMessage({ message });
const foldCreationDialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.creationDialog),
  write: (model, creationDialog) => ({ ...model, creationDialog }),
  toParentMessage: toCreationDialogMessage,
  foldOutMessage: () => (model) => ({ model }),
});
const closeCreationMenu = (model: Model) =>
  foldCreationDialog(
    { ...model, creationMenu: null },
    Dialog.Message.RequestedClose(),
  );
const FocusCreationTitle = Command.define("FocusCreationTitle", {
  args: { id: Schema.String },
  messages: [Message.FocusedCreationTitle],
  execute: ({ id }) =>
    focus(`#${id}`).pipe(
      Effect.ignore,
      Effect.as(Message.FocusedCreationTitle()),
    ),
});
const foldTaskFeature = Update.foldChild({
  update: Tasks.update,
  read: (model: Model) =>
    model.account ? Option.some(model.tasks) : Option.none(),
  write: (model, tasks) => ({ ...model, tasks }),
  toParentMessage: toTasksMessage,
  foldOutMessage:
    (out: Tasks.OutMessage): Update.Step<Model, Message> =>
    (model) => {
      if (out._tag === "SessionExpired")
        return update(model, Message.LoadedAccount({ account: null }));
      return model.page === "tasks"
        ? {
            model,
            commands: [
              Navigate({
                href: taskPath(out.id, model.tasks.view),
                mode: "push",
              }),
            ],
          }
        : { model };
    },
});

const creationEditor = (model: Model) =>
  model.tasks.creation
    ? "task"
    : Calendar.hasGlobalEventEditor(model.calendar)
      ? "event"
      : null;

const foldCreationEditor = (model: Model, step: Update.Step<Model, Message>) =>
  Update.combine(model, [
    step,
    (next) => {
      const editor = creationEditor(next);
      if (creationEditor(model) === editor) return { model: next };
      if (!editor)
        return foldCreationDialog(next, Dialog.Message.RequestedClose());
      if (next.creationMenu)
        return {
          model: { ...next, creationMenu: null },
          commands: [
            FocusCreationTitle({
              id:
                editor === "task"
                  ? Tasks.creationTitleId
                  : Calendar.creationTitleId,
            }),
          ],
        };
      return foldCreationDialog(next, Dialog.Message.RequestedOpen());
    },
  ]);

const foldTasks = (model: Model, message: Tasks.Message) =>
  foldCreationEditor(model, (next) => foldTaskFeature(next, message));

const foldCalendar = (model: Model, message: typeof Calendar.Message.Type) =>
  foldCreationEditor(model, (next) => foldCalendarFeature(next, message));

const toFilesMessage = (message: Files.Message) =>
  Message.GotFilesMessage({ message });
const foldFiles = Update.foldChild({
  update: Files.update,
  read: (model: Model) =>
    model.account ? Option.some(model.files) : Option.none(),
  write: (model, files) => ({ ...model, files }),
  toParentMessage: toFilesMessage,
  foldOutMessage:
    (out: Files.OutMessage): Update.Step<Model, Message> =>
    (model) => {
      if (out._tag === "SessionExpired")
        return update(model, Message.LoadedAccount({ account: null }));
      return model.page === "files"
        ? {
            model,
            commands: [Navigate({ href: filePath(out.id), mode: "push" })],
          }
        : { model };
    },
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

const creationItems = [
  { value: "task", label: "Task", iconPaths: taskIconPaths },
  { value: "event", label: "Event", iconPaths: calendarIconPaths },
] as const;
const creationMenu =
  CommandMenu.create<(typeof creationItems)[number]["value"]>();
const toCreationMenu = (message: typeof CommandMenu.Message.Type) =>
  Message.GotCreationMenuMessage({ message });
const foldCreationMenu = Update.foldChild({
  update: creationMenu.update,
  read: (model: Model) => Option.fromNullishOr(model.creationMenu),
  write: (model, creationMenu) => ({ ...model, creationMenu }),
  toParentMessage: toCreationMenu,
  foldOutMessage:
    (out): Update.Step<Model, Message> =>
    (model) =>
      out._tag !== "Selected"
        ? { model }
        : out.value === "event"
          ? foldCalendar(
              model,
              Calendar.Message.OpenedCreate({
                useCalendarContext: model.page === "calendar",
              }),
            )
          : foldTasks(
              model,
              Tasks.Message.OpenedCreate({ preserveView: true }),
            ),
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
      yield* Effect.tryPromise(clearPushAfterSignOut).pipe(Effect.ignore);
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

const isApproval = (model: Model) =>
  connectingMcp ||
  model.cliLogin !== null ||
  model.extensionAccess.approvalId !== null ||
  model.extensionAccess.approved;

const closeFolderSheet = (model: Model): Update.Return<Model, Message> => {
  if (model.page === "settings")
    return foldSettingsSheet(model, Sheet.Message.RequestedClose());
  if (model.page === "calendar")
    return foldCalendar(model, Calendar.closeFolderSheet());
  if (model.page === "tasks") return foldTasks(model, Tasks.closeFolderSheet());
  return model.page === "contacts"
    ? foldPeople(model, People.closeFolderSheet())
    : foldInbox(model, Inbox.closeFolderSheet());
};

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.closest(
      'input, textarea, select, [role="textbox"], [role="combobox"]',
    ) !== null);

const isCreationShortcut = (event: KeyboardEvent) =>
  event.key.toLowerCase() === "c" &&
  !event.defaultPrevented &&
  !event.isComposing &&
  !event.repeat &&
  !event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey &&
  !document.querySelector('dialog:modal, dialog[open][aria-modal="true"]') &&
  !isEditable(event.target) &&
  !isEditable(document.activeElement);

const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  creationShortcut: entry(
    { active: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        active: model.account !== null && !isApproval(model),
      }),
      dependenciesToStream: ({ active }) =>
        active
          ? Stream.fromEventListener<KeyboardEvent>(document, "keydown").pipe(
              Stream.filter(isCreationShortcut),
              Stream.map(() => Message.OpenedCreationMenu()),
            )
          : Stream.empty,
    },
  ),
  folderSheet: entry(
    { open: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        open:
          model.inbox.folderSheet.isOpen ||
          model.people.directory.folderSheet.isOpen ||
          model.calendar.folderSheet.isOpen ||
          model.tasks.folderSheet.isOpen ||
          model.settingsSheet.isOpen,
      }),
      dependenciesToStream: ({ open }) =>
        open
          ? Stream.fromEventListener<MediaQueryListEvent>(
              matchMedia(workspaceDrawerMedia),
              "change",
            ).pipe(
              Stream.filter((event) => !event.matches),
              Stream.map(() => Message.RequestedFolderSheetClose()),
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
  if (model.page === "links")
    return foldLinks(model, Links.Message.Requested());
  if (model.calendarRoute)
    return foldCalendar(
      model,
      Calendar.Message.Opened({
        id: model.calendarRoute.id,
        refresh: previousPage !== "calendar",
      }),
    );
  if (model.taskRoute)
    return foldTasks(
      model,
      Tasks.Message.Opened({
        ...model.taskRoute,
        refresh: previousPage !== "tasks",
      }),
    );
  if (model.fileRoute)
    return foldFiles(
      model,
      Files.Message.Opened({
        id: model.fileRoute.id,
        refresh: previousPage !== "files",
      }),
    );
  if (model.page === "vault")
    return foldVaultSetup(model, VaultSetup.Message.Requested());
  if (model.mailRoute)
    return foldInbox(model, Inbox.Message.Opened(model.mailRoute));
  if (model.peopleRoute)
    return foldPeople(
      model,
      People.Message.VisitedDirectory({
        id: model.peopleRoute.id,
        refresh: previousPage !== "contacts",
      }),
    );
  switch (model.settingsSection) {
    case "account":
      return Update.combine(model, [
        (next) =>
          applyNotification(next, {
            _tag: "DismissNotification",
            key: AccountSettings.notificationKey,
          }),
        (next) => foldPeople(next, People.Message.RequestedSelf()),
      ]);
    case "notifications":
      return foldPushSettings(model, PushSettings.Message.Requested());
    case "clients":
      return foldConnectedClients(model, ConnectedClients.Message.Requested());
    case null:
      return { model };
  }
};

const init: Runtime.RoutingApplicationInit<Model, Message> = (url) => {
  const page = pageFor(url);
  const model: Model = {
    page,
    navigation: AppNavigation.initial,
    account: null,
    appearance: AccountSettings.initialAppearance,
    sessionCheck: "checking",
    accountSettings: AccountSettings.initial,
    settingsSection: settingsSectionFor(url),
    settingsSheet: Sheet.init({ id: settingsSheetId }),
    pushSettings: PushSettings.initial,
    vaultSetup: VaultSetup.initial,
    inbox: Inbox.initial,
    people: People.initial,
    calendar: Calendar.initial(),
    calendarRoute: calendarRouteFor(url.pathname),
    tasks: Tasks.initial,
    files: Files.initial,
    fileRoute: fileRouteFor(url.pathname),
    creationDialog: Dialog.init({ id: Tasks.creationDialogId }),
    creationMenu: null,
    taskRoute: taskRouteFor(url.pathname),
    mailRoute: mailRouteFor(url.pathname),
    peopleRoute: contactsRouteFor(url.pathname),
    signInNotice: null,
    links: Links.initial,
    notifications: Notifications.init(),
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
    const path = model.settingsSection
      ? settingsSectionPath(model.settingsSection)
      : `/${page}`;
    commands.push(
      Navigate({ href: `${path}${hash ? "#" + hash : ""}`, mode: "replace" }),
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
      const settingsSection =
        request._tag === "Internal" ? settingsSectionFor(request.url) : null;
      if (
        request._tag === "Internal" &&
        !isApproval(model) &&
        (request.url.pathname === "/links" ||
          settingsSection ||
          request.url.pathname === vaultPath ||
          calendarRouteFor(request.url.pathname) ||
          taskRouteFor(request.url.pathname) ||
          fileRouteFor(request.url.pathname) ||
          mailRouteFor(request.url.pathname) ||
          contactsRouteFor(request.url.pathname))
      ) {
        const from = closeFolderSheet(model);
        if (
          request.url.pathname === window.location.pathname &&
          (!settingsSection || settingsSection === model.settingsSection)
        )
          return from;
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
      const settingsSection = settingsSectionFor(url);
      const mailRoute = mailRouteFor(url.pathname);
      const calendarRoute = calendarRouteFor(url.pathname);
      const taskRoute = taskRouteFor(url.pathname);
      const fileRoute = fileRouteFor(url.pathname);
      const peopleRoute = contactsRouteFor(url.pathname);
      const sameRoute =
        page === model.page &&
        settingsSection === model.settingsSection &&
        calendarRoute?.id === model.calendarRoute?.id &&
        taskRoute?.id === model.taskRoute?.id &&
        taskRoute?.view === model.taskRoute?.view &&
        fileRoute?.id === model.fileRoute?.id &&
        mailRoute?.folder === model.mailRoute?.folder &&
        mailRoute?.id === model.mailRoute?.id &&
        peopleRoute?.id === model.peopleRoute?.id &&
        peopleRoute?.section === model.peopleRoute?.section;
      const result = sameRoute
        ? { model }
        : Update.combine(model, [
            closeFolderSheet,
            (next) =>
              next.creationMenu ? closeCreationMenu(next) : { model: next },
            (next) =>
              loadPage(
                {
                  ...next,
                  page,
                  settingsSection,
                  calendarRoute,
                  taskRoute,
                  fileRoute,
                  mailRoute,
                  peopleRoute,
                  error: null,
                },
                model.page,
              ),
          ]);
      const canonicalNavigation = canonicalMailNavigation(url, mailRoute);
      return canonicalNavigation
        ? {
            ...result,
            commands: [...(result.commands ?? []), canonicalNavigation],
          }
        : result;
    },
    RequestedFolderSheetClose: () => closeFolderSheet(model),
    GotSettingsSheetMessage: ({ message }) => foldSettingsSheet(model, message),
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
        appearance: AccountSettings.initialAppearance,
        sessionCheck: "resolved",
        accountSettings: AccountSettings.initial,
        settingsSection: model.settingsSection,
        settingsSheet: Sheet.init({ id: settingsSheetId }),
        pushSettings: PushSettings.initial,
        vaultSetup: VaultSetup.initial,
        inbox: Inbox.initial,
        people: People.initial,
        calendar: Calendar.initial(),
        calendarRoute: model.calendarRoute,
        tasks: Tasks.initial,
        files: Files.initial,
        fileRoute: model.fileRoute,
        creationDialog: Dialog.init({ id: Tasks.creationDialogId }),
        creationMenu: null,
        taskRoute: model.taskRoute,
        mailRoute: model.mailRoute,
        peopleRoute: model.peopleRoute,
        signInNotice: null,
        links: Links.initial,
        notifications: Notifications.clear(model.notifications),
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
    GotAppearanceMessage: ({ message }) => {
      const { account, appearance } = model;
      if (!account) return { model };
      const save = (theme: ThemePreference): Update.Return<Model, Message> => {
        if (
          model.pending ||
          appearance._tag === "Saving" ||
          theme === account.theme
        )
          return { model };
        const request = crypto.randomUUID();
        return {
          model: { ...model, appearance: { _tag: "Saving", request, theme } },
          commands: [
            Command.mapMessage(
              AccountSettings.SaveTheme({ requestId: request, theme }),
              toAppearanceMessage,
            ),
          ],
        };
      };
      switch (message._tag) {
        case "SelectedTheme":
          return isThemePreference(message.value)
            ? save(message.value)
            : { model };
        case "RetriedTheme":
          return appearance._tag === "Failed"
            ? save(appearance.theme)
            : { model };
        case "FinishedSavingTheme":
          if (
            appearance._tag !== "Saving" ||
            appearance.request !== message.request
          )
            return { model };
          if (message.outcome === "signed-out" && !model.pending)
            return update(model, Message.LoadedAccount({ account: null }));
          return {
            model:
              message.outcome === "saved"
                ? {
                    ...model,
                    account: { ...account, theme: appearance.theme },
                    appearance: AccountSettings.initialAppearance,
                  }
                : {
                    ...model,
                    appearance: { _tag: "Failed", theme: appearance.theme },
                  },
          };
      }
    },
    CompletedAccountSettingsRequest: ({ request, message }) =>
      model.accountSettings.request === request &&
      model.accountSettings.pending !== null
        ? update(model, Message.GotAccountSettingsMessage({ message }))
        : { model },
    GotPushSettingsMessage: ({ message }) => foldPushSettings(model, message),
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
      ) => {
        if (model.pending || settings.pending) return { model };
        const request = crypto.randomUUID();
        return {
          model: {
            ...model,
            accountSettings: { ...settings, pending, request, error: "" },
          },
          commands: [
            Command.mapMessage(command, (message) =>
              message._tag === "GotAccountSettingsMessage"
                ? Message.CompletedAccountSettingsRequest({
                    request,
                    message: message.message,
                  })
                : message,
            ),
          ],
        };
      };
      const verified = () => ({
        model: {
          ...model,
          account: { ...account, emailVerified: true },
          accountSettings: AccountSettings.initial,
        },
      });
      const signedOut = (notice: string | null) => {
        const closing = foldAccountDialog(
          model,
          Dialog.Message.RequestedClose(),
        );
        const result = update(
          closing.model,
          Message.LoadedAccount({ account: null }),
        );
        return {
          model: { ...result.model, signInNotice: notice },
          commands: [...(closing.commands ?? []), ...(result.commands ?? [])],
        };
      };
      const result = AccountSettings.Message.match<
        Update.Return<Model, Message>
      >(message, {
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
          settings.dialog?.kind === "password"
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
                    request: null,
                    verification,
                  },
                },
                commands: [focusAccountElement("#email-code")],
              }
            : verified(),
        EmailVerified: verified,
        PasswordChanged: () =>
          signedOut("Password changed. Sign in with your new password."),
        OpenDialog: ({ dialog }) => {
          if (
            model.pending ||
            settings.pending ||
            (dialog === "email" && !account.emailDeliveryEnabled)
          )
            return { model };
          const next = {
            ...model,
            accountSettings: {
              ...settings,
              dialog: { kind: dialog, key: crypto.randomUUID() },
              emailChange: null,
              error: "",
            },
          };
          return settings.modal.isOpen
            ? { model: next, commands: [focusAccountElement("#new-email")] }
            : foldAccountDialog(next, Dialog.Message.RequestedOpen());
        },
        CloseDialog: () =>
          settings.modal.isOpen && !model.pending && !settings.pending
            ? foldAccountDialog(
                {
                  ...model,
                  accountSettings: {
                    ...settings,
                    dialog: null,
                    emailChange: null,
                    error: "",
                  },
                },
                Dialog.Message.RequestedClose(),
              )
            : { model },
        GotDialogMessage: ({ message }) =>
          message._tag === "RequestedClose"
            ? update(
                model,
                toAccountSettingsMessage(AccountSettings.Message.CloseDialog()),
              )
            : foldAccountDialog(model, message),
        DialogUpdated: () => ({ model }),
        SubmitEmailChange: () =>
          settings.dialog?.kind === "email" && !settings.emailChange
            ? start(
                "send-email-change",
                Command.mapMessage(
                  AccountSettings.SubmitEmailChange({}),
                  toAccountSettingsMessage,
                ),
              )
            : { model },
        ConfirmEmailChange: () =>
          settings.dialog?.kind === "email" && settings.emailChange
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
              request: null,
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
            accountSettings: {
              ...settings,
              pending: null,
              request: null,
              error,
            },
          },
        }),
      });
      const feedback = AccountSettings.feedback(
        settings,
        message,
        model.settingsSection === "account",
      );
      if (!feedback) return result;
      const notified = applyNotification(result.model, feedback);
      return {
        model: notified.model,
        commands: [...(result.commands ?? []), ...(notified.commands ?? [])],
      };
    },
    GotCalendarMessage: ({ message }) => foldCalendar(model, message),
    GotTasksMessage: ({ message }) => foldTasks(model, message),
    GotFilesMessage: ({ message }) => foldFiles(model, message),
    OpenedCreationMenu: () =>
      model.account &&
      !isApproval(model) &&
      !model.creationMenu &&
      !creationEditor(model)
        ? foldCreationDialog(
            {
              ...model,
              creationMenu: CommandMenu.init({ id: "creation-command" }),
            },
            Dialog.Message.RequestedOpen(),
          )
        : { model },
    GotCreationDialogMessage: ({ message }) => {
      if (message._tag === "RequestedClose") {
        switch (creationEditor(model)) {
          case "task":
            return foldTasks(model, Tasks.Message.ClosedCreate());
          case "event":
            return foldCalendar(model, Calendar.Message.ClosedEventEditor());
          case null:
            return closeCreationMenu(model);
        }
      }
      const result = foldCreationDialog(model, message);
      return model.creationDialog.isOpen && !result.model.creationDialog.isOpen
        ? {
            ...result,
            model: {
              ...result.model,
              creationMenu: null,
              tasks: { ...result.model.tasks, creation: null },
              calendar: Calendar.hasGlobalEventEditor(model.calendar)
                ? { ...result.model.calendar, editor: null }
                : result.model.calendar,
            },
          }
        : result;
    },
    FocusedCreationTitle: () => ({ model }),
    GotCreationMenuMessage: ({ message }) => foldCreationMenu(model, message),
    GotLinksMessage: ({ message }) =>
      model.pending &&
      ["Submitted", "RequestedDeletion", "Retried"].includes(message._tag)
        ? { model }
        : foldLinks(model, message),
    GotNotificationMessage: ({ message }) =>
      model.pending &&
      message._tag === "GotToast" &&
      message.message._tag === "ActivatedToastAction"
        ? { model }
        : foldNotifications(model, message),
    RequestFailed: ({ error }) => ({
      model: { ...model, pending: false, error },
    }),
    GotVaultSetupMessage: ({ message }) => foldVaultSetup(model, message),
    GotPeopleMessage: ({ message }) => {
      const { selfRequest, loadRequest, saveRequest, directory } = model.people;
      if (
        message._tag === "SessionExpired" &&
        ([
          selfRequest,
          loadRequest,
          saveRequest,
          directory.listRequest,
          directory.editRequest,
          directory.deletion?.request,
        ].includes(message.request) ||
          Object.hasOwn(directory.restorations, message.request))
      )
        return update(model, Message.LoadedAccount({ account: null }));
      const result = foldPeople(model, message);
      const deleted =
        message._tag === "DeletedRecord" &&
        message.request === directory.deletion?.request
          ? directory.deletion
          : null;
      if (
        deleted &&
        model.page === "contacts" &&
        model.peopleRoute?.id === deleted.id
      )
        return {
          ...result,
          commands: [
            ...(result.commands ?? []),
            Navigate({ href: contactsListPath(deleted.kind), mode: "replace" }),
          ],
        };
      const saved =
        message._tag === "Saved" &&
        (message.request === saveRequest ||
          message.request === directory.editRequest);
      const restored =
        message._tag === "RestoredRecord" &&
        directory.restorations[message.request]?.id === message.person.id;
      if (model.page !== "mail" || !(saved || deleted || restored))
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
            ...(message.suggestedCompany
              ? { suggestedKind: "company" as const }
              : {}),
            ...(message.suggestedDomain
              ? { suggestedDomain: message.suggestedDomain }
              : {}),
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
          message.request === model.inbox.filters.contactsRequest ||
          message.request === model.inbox.entryRequest ||
          message.request === model.inbox.imageRequest ||
          message.request === model.inbox.recovery.request ||
          message.request === model.inbox.threadRequest ||
          message.request === model.inbox.unreadRequest ||
          Object.values(model.inbox.readRequests).some(
            ({ request }) => request === message.request,
          ) ||
          message.request === model.inbox.compose.request ||
          message.request === model.inbox.quickReply.request ||
          message.request === model.inbox.senderRuleRequest?.request ||
          message.request === model.inbox.attachmentPreview.preview?.request ||
          message.request === deleting?.request ||
          message.request === moving?.request)
      ) {
        return update(model, Message.LoadedAccount({ account: null }));
      }
      const result = foldInbox(model, message);
      if (
        message._tag === "GotRecoveryMessage" &&
        message.message._tag === "Restored" &&
        model.inbox.recovery.request === message.message.request &&
        model.inbox.recovery.restoring === message.message.id &&
        model.mailRoute?.folder === "trash" &&
        model.mailRoute.id &&
        (message.message.members?.ids ?? [message.message.id]).includes(
          model.mailRoute.id,
        )
      )
        return {
          ...result,
          commands: [
            ...(result.commands ?? []),
            Navigate({ href: folderPath("trash"), mode: "replace" }),
          ],
        };
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
        deleting.id === message.id &&
        Boolean(deleting.conversationView) === Boolean(message.conversation) &&
        model.mailRoute?.id &&
        model.mailRoute.folder !== "trash" &&
        (message.conversation?.ids ?? [message.id]).includes(model.mailRoute.id)
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

const accountSettingsView = (model: Model, h: HtmlBuilder<Message>) => [
  h.section(
    [h.Class("settings-section"), h.AriaLabelledBy("settings-profile")],
    [
      h.h2([h.Id("settings-profile")], ["Profile"]),
      itemGroup(
        [
          item(
            {
              key: "settings-profile",
              title: model.people.self?.name || "Your profile",
              media: People.profileAvatar(
                h,
                model.people.self,
                model.people.self?.managedAddresses[0] ??
                  model.account?.email ??
                  "",
                {
                  imageMounted: toPeopleMessage(People.Message.Mounted()),
                },
              ),
              action: button(
                {
                  size: "sm",
                  variant: "outline",
                  dialogId: People.dialogId,
                  onClick: toPeopleMessage(
                    People.Message.Opened({ address: null }),
                  ),
                  children: ["Edit profile"],
                },
                h,
              ),
            },
            h,
          ),
        ],
        h,
      ),
    ],
  ),
  ...(model.account
    ? [
        AccountSettings.appearanceView(
          model.account.theme,
          model.appearance,
          model.pending,
          h,
          toAppearanceMessage,
        ),
        h.section(
          [h.Class("settings-section"), h.AriaLabelledBy("settings-account")],
          [
            h.h2([h.Id("settings-account")], ["Sign-in and security"]),
            ...AccountSettings.view(
              model.account,
              model.accountSettings,
              model.pending,
              h,
              toAccountSettingsMessage,
              button(
                {
                  size: "sm",
                  variant: "ghost",
                  disabled:
                    model.pending ||
                    model.accountSettings.pending !== null ||
                    model.connectedClients.request !== null,
                  onClick: Message.ClickedSignOut(),
                  children: ["Sign out"],
                },
                h,
              ),
            ),
          ],
        ),
      ]
    : []),
];

const settingsView = (model: Model, h: HtmlBuilder<Message>) => {
  const section = model.settingsSection ?? "account";
  const navigation = settingsNavigation(section, h);
  const content = {
    account: () => accountSettingsView(model, h),
    notifications: () => [
      PushSettings.view(model.pushSettings, toPushSettingsMessage, h),
    ],
    clients: () => [
      h.submodel({
        slotId: "connected-clients",
        view: ConnectedClients.view,
        model: model.connectedClients,
        toParentMessage: toConnectedClientsMessage,
      }),
    ],
  }[section]();

  return workspace(
    {
      className: "workspace-stacked settings-workspace",
      title: settingsSectionLabel(section),
      headerActions: [
        h.div(
          [h.Class("workspace-drawer-trigger")],
          [
            button(
              {
                variant: "ghost",
                size: "icon",
                rounded: true,
                ariaLabel: "Settings sections",
                dialogId: model.settingsSheet.id,
                onClick: toSettingsSheetMessage(Sheet.Message.RequestedOpen()),
                children: [outlineIcon(h, ["M4 6h16M4 12h16M4 18h16"])],
              },
              h,
            ),
          ],
        ),
      ],
      sidebar: navigation,
      hasSelection: false,
      list: h.div(
        [h.Class("workspace-list")],
        [
          h.div(
            [h.Key(section), h.Class("workspace-results")],
            [h.div([h.Class("settings-content")], content)],
          ),
        ],
      ),
      sheet: Sheet.sheet(
        {
          model: model.settingsSheet,
          title: "Settings sections",
          content: navigation,
          toParentMessage: toSettingsSheetMessage,
        },
        h,
      ),
    },
    h,
  );
};

const signInView = (model: Model, h: HtmlBuilder<Message>) =>
  h.form(
    [h.Id("sign-in"), h.Method("post"), h.OnSubmit(Message.SubmittedSignIn())],
    [
      ...(model.cliLogin
        ? [h.p([], ["Sign in to connect the OneApp CLI."])]
        : model.extensionAccess.approvalId
          ? [h.p([], ["Sign in to connect the OneApp extension."])]
          : []),
      field(
        "Email",
        input(
          [
            h.Id("email"),
            h.Name("email"),
            h.Type("email"),
            h.Autocomplete("username"),
            h.Required(true),
          ],
          h,
        ),
        h,
      ),
      field(
        "Password",
        input(
          [
            h.Id("password"),
            h.Name("password"),
            h.Type("password"),
            h.Autocomplete("current-password"),
            h.Required(true),
          ],
          h,
        ),
        h,
      ),
      alert(
        { message: model.error, severity: "error", announcement: "alert" },
        h,
      ),
      button(
        {
          type: "submit",
          disabled: model.pending,
          focusableWhenDisabled: true,
          children: [model.pending ? "Signing in…" : "Sign in"],
        },
        h,
      ),
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

const pageView = (model: Model, h: HtmlBuilder<Message>): Document => {
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
          ...(model.account ? [error] : []),
        ],
      ),
    };
  }
  const title = {
    links: "Links",
    mail: "Mail",
    calendar: "Calendar",
    tasks: "Tasks",
    files: "Files",
    vault: "Vault",
    contacts: "Contacts",
    settings: "Settings",
  }[model.page];
  const usesOwnHeading =
    model.page === "links" ||
    model.page === "mail" ||
    model.page === "calendar" ||
    model.page === "tasks" ||
    model.page === "files" ||
    model.page === "contacts" ||
    model.page === "settings" ||
    (model.page === "vault" && model.vaultSetup.status?.initialized === true);
  const menu = model.creationMenu;
  const creatingEvent = creationEditor(model) === "event";
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
              links: () =>
                h.submodel({
                  slotId: "links",
                  view: Links.view,
                  model: model.links,
                  viewInputs: { disabled: model.pending },
                  toParentMessage: toLinksMessage,
                }),
              mail: () =>
                h.submodel({
                  slotId: "inbox",
                  view: Inbox.view,
                  model: model.inbox,
                  toParentMessage: toInboxMessage,
                }),
              calendar: () =>
                h.submodel({
                  slotId: "calendar",
                  view: Calendar.view,
                  model: model.calendar,
                  toParentMessage: toCalendarMessage,
                }),
              tasks: () =>
                h.submodel({
                  slotId: "tasks",
                  view: tasksView,
                  model: model.tasks,
                  toParentMessage: toTasksMessage,
                }),
              files: () =>
                h.submodel({
                  slotId: "files",
                  view: filesView,
                  model: model.files,
                  toParentMessage: toFilesMessage,
                }),
              vault: () =>
                h.submodel({
                  slotId: "vault-setup",
                  view: VaultSetup.view,
                  model: model.vaultSetup,
                  toParentMessage: toVaultSetupMessage,
                }),
              contacts: () =>
                h.submodel({
                  slotId: "people-directory",
                  view: PeopleDirectory.view,
                  model: model.people.directory,
                  viewInputs: {
                    section: model.peopleRoute?.section ?? "person",
                  },
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
        Dialog.view(
          {
            model: model.creationDialog,
            title: menu ? "Create" : creatingEvent ? "New event" : "Add task",
            padded: menu === null,
            showHeader: menu === null,
            showCloseButton: false,
            content: (initialFocus) =>
              menu
                ? creationMenu.view(
                    {
                      model: menu,
                      items: creationItems,
                      searchLabel: "Search create options",
                      initialFocus,
                      toParentMessage: toCreationMenu,
                    },
                    h,
                  )
                : creatingEvent
                  ? h.submodel({
                      slotId: "event-creation",
                      view: Calendar.createView,
                      model: model.calendar,
                      viewInputs: initialFocus,
                      toParentMessage: toCalendarMessage,
                    })
                  : h.submodel({
                      slotId: "task-creation",
                      view: taskCreateView,
                      model: model.tasks,
                      viewInputs: initialFocus,
                      toParentMessage: toTasksMessage,
                    }),
            toParentMessage: toCreationDialogMessage,
          },
          h,
        ),
      ],
    ),
  };
};

const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const page = pageView(model, h);
  return {
    ...page,
    body: h.div(
      [],
      [
        page.body,
        notificationView(model.notifications, toNotificationMessage, h),
      ],
    ),
  };
};

const themeFor = (model: Model) =>
  model.account
    ? AccountSettings.displayedTheme(model.account.theme, model.appearance)
    : "system";

const updateWithTheme = (model: Model, message: Message) => {
  const result = update(model, message);
  const theme = themeFor(result.model);
  // Project the preference before Foldkit renders the next workspace frame.
  if (theme !== themeFor(model)) AccountSettings.applyDocumentTheme(theme);
  return result;
};

if (window.isSecureContext && "serviceWorker" in navigator)
  void registerServiceWorker().catch(() => {
    /* Settings exposes registration failures. */
  });

if (bitwardenAuthorization && !connectingBitwarden) {
  window.location.replace(bitwardenAuthorization);
} else if (PasswordRecovery.isRecoveryPage(window.location.pathname)) {
  PasswordRecovery.run(window.location.pathname);
} else
  Runtime.run(
    Runtime.makeApplication({
      Model,
      init,
      update: updateWithTheme,
      view,
      subscriptions,
      routing: {
        onUrlRequest: (request) => Message.RequestedUrl({ request }),
        onUrlChange: (url) => Message.ChangedUrl({ url }),
      },
      container: document.getElementById("root"),
    }),
  );
