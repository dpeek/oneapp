import {
  alert,
  button,
  Dialog,
  field,
  input,
  item,
  itemGroup,
  nativeSelect,
} from "@oneapp/ui";
import { Effect, Schema } from "effect";
import { Command } from "foldkit";
import { focus } from "foldkit/dom";
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import {
  ChangedEmail,
  emailChangePath,
  EmailVerification,
  emailVerificationPath,
  passwordChangePath,
  PendingEmailChange,
  ThemePreference,
  themePreferencePath,
} from "./account-contract.ts";
import type { Account } from "./auth-contract.ts";
import { Notification } from "./notifications.ts";

const DialogKind = Schema.Literals(["email", "password"]);
const dialogId = "account-settings-dialog";

export const Model = Schema.Struct({
  request: Schema.NullOr(Schema.String),
  pending: Schema.NullOr(
    Schema.Literals([
      "send",
      "verify",
      "password",
      "send-email-change",
      "confirm-email-change",
    ]),
  ),
  verification: Schema.NullOr(EmailVerification),
  modal: Dialog.Model,
  dialog: Schema.NullOr(
    Schema.Struct({ kind: DialogKind, key: Schema.String }),
  ),
  emailChange: Schema.NullOr(PendingEmailChange),
  error: Schema.String,
});
type Model = typeof Model.Type;
export const initial: Model = {
  request: null,
  pending: null,
  verification: null,
  modal: Dialog.init({ id: dialogId }),
  dialog: null,
  emailChange: null,
  error: "",
};

export const Message = defineMessageUnion({
  SendCode: {},
  VerifyCode: {},
  ChangePassword: {},
  OpenDialog: { dialog: DialogKind },
  CloseDialog: {},
  GotDialogMessage: { message: Dialog.Message },
  DialogUpdated: {},
  SubmitEmailChange: {},
  ConfirmEmailChange: {},
  EmailChangeStarted: { change: PendingEmailChange },
  EmailChanged: ChangedEmail.fields,
  CodeSent: { verification: Schema.NullOr(EmailVerification) },
  EmailVerified: {},
  PasswordChanged: {},
  SignedOut: {},
  Failed: { error: Schema.String },
});
type Message = typeof Message.Type;

export const Appearance = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Saving", {
    request: Schema.String,
    theme: ThemePreference,
  }),
  Schema.TaggedStruct("Failed", { theme: ThemePreference }),
]);
type Appearance = typeof Appearance.Type;

export const initialAppearance: Appearance = { _tag: "Idle" };

export const AppearanceMessage = defineMessageUnion({
  SelectedTheme: { value: Schema.String },
  RetriedTheme: {},
  FinishedSavingTheme: {
    request: Schema.String,
    outcome: Schema.Literals(["saved", "failed", "signed-out"]),
  },
});
type AppearanceMessage = typeof AppearanceMessage.Type;

export const displayedTheme = (
  saved: ThemePreference,
  appearance: Appearance,
) => (appearance._tag === "Saving" ? appearance.theme : saved);

export const applyDocumentTheme = (theme: ThemePreference) => {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;

  for (const meta of document.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"][data-color-scheme]',
  )) {
    const scheme = meta.dataset.colorScheme;
    meta.media =
      theme === "system"
        ? `(prefers-color-scheme: ${scheme})`
        : theme === scheme
          ? "all"
          : "not all";
  }
};

export const notificationKey = "account-settings";
export const OutMessage = defineMessageUnion({
  Notify: { notification: Notification },
  DismissNotification: { key: Schema.String },
});
export type OutMessage = typeof OutMessage.Type;

// Authentication details stay in their forms. Only a generic missed failure
// crosses into notification state; server messages may contain user input.
export const feedback = (
  model: Model,
  message: Message,
  visible: boolean,
): OutMessage | undefined => {
  if (!model.pending) return undefined;
  if (message._tag === "Failed")
    return visible
      ? OutMessage.DismissNotification({ key: notificationKey })
      : OutMessage.Notify({
          notification: {
            key: notificationKey,
            variant: "Error",
            title:
              "Could not complete the account change. Return to Settings to review and try again.",
          },
        });
  if (
    message._tag === "CodeSent" ||
    message._tag === "EmailVerified" ||
    message._tag === "EmailChangeStarted"
  )
    return OutMessage.DismissNotification({ key: notificationKey });
  return undefined;
};

export const FocusElement = Command.define("FocusAccountElement", {
  args: { selector: Schema.String },
  messages: [Message.DialogUpdated],
  execute: ({ selector }) =>
    focus(selector).pipe(Effect.ignore, Effect.as(Message.DialogUpdated())),
});

const request = <Success>(
  path: string,
  body: object,
  onSuccess: (response: Response) => Promise<Success>,
) =>
  Effect.tryPromise(async (signal) => {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-effect-auth-csrf": "1",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (response.status === 401) return Message.SignedOut();
    if (response.ok) return onSuccess(response);
    const error = Schema.decodeUnknownSync(
      Schema.Struct({ error: Schema.String }),
    )(await response.json());
    return Message.Failed(error);
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        Message.Failed({ error: "Could not complete the request. Try again." }),
      ),
    ),
  );

export const SaveTheme = Command.define("SaveAccountTheme", {
  args: { requestId: Schema.String, theme: ThemePreference },
  messages: [AppearanceMessage.FinishedSavingTheme],
  execute: ({ requestId, theme }) =>
    request(themePreferencePath, { theme }, async () => null).pipe(
      Effect.map((result) =>
        AppearanceMessage.FinishedSavingTheme({
          request: requestId,
          outcome:
            result === null
              ? "saved"
              : result._tag === "SignedOut"
                ? "signed-out"
                : "failed",
        }),
      ),
    ),
});

const form = (id: string) => {
  const element = document.getElementById(id);
  return element instanceof HTMLFormElement ? element : undefined;
};

const readCode = (id: string) => {
  const element = form(id);
  const value = element && new FormData(element).get("code");
  return typeof value === "string" && /^\d{6}$/.test(value.trim())
    ? value.trim()
    : null;
};

export const SendCode = Command.define("RequestEmailVerificationCode", {
  args: {},
  messages: [Message.CodeSent, Message.SignedOut, Message.Failed],
  execute: () =>
    request(emailVerificationPath, {}, async (response) =>
      Message.CodeSent({
        verification:
          response.status === 204
            ? null
            : Schema.decodeUnknownSync(EmailVerification)(
                await response.json(),
              ),
      }),
    ),
});

export const VerifyCode = Command.define("VerifyAccountEmail", {
  args: { verification: EmailVerification },
  messages: [Message.EmailVerified, Message.SignedOut, Message.Failed],
  execute: ({ verification }) =>
    Effect.suspend(() => {
      const code = readCode("verify-account-email");
      if (!code) {
        return Effect.succeed(
          Message.Failed({ error: "Enter the six-digit code." }),
        );
      }
      return request(
        `${emailVerificationPath}/confirm`,
        { ...verification, code },
        async () => Message.EmailVerified(),
      );
    }),
});

export const SubmitEmailChange = Command.define("SubmitEmailChange", {
  args: {},
  messages: [Message.EmailChangeStarted, Message.SignedOut, Message.Failed],
  execute: () =>
    Effect.suspend(() => {
      const element = form("change-account-email");
      if (!element)
        return Effect.succeed(
          Message.Failed({ error: "Could not read the email form." }),
        );
      const fields = new FormData(element);
      const email = fields.get("new-email");
      const currentPassword = fields.get("email-current-password");
      const passwordInput = element.querySelector<HTMLInputElement>(
        "#email-current-password",
      );
      if (passwordInput) passwordInput.value = "";
      return request(
        emailChangePath,
        { email, currentPassword },
        async (response) =>
          Message.EmailChangeStarted({
            change: Schema.decodeUnknownSync(PendingEmailChange)(
              await response.json(),
            ),
          }),
      );
    }),
});

export const ConfirmEmailChange = Command.define("ConfirmEmailChange", {
  args: { id: PendingEmailChange.fields.id },
  messages: [Message.EmailChanged, Message.SignedOut, Message.Failed],
  execute: ({ id }) =>
    Effect.suspend(() => {
      const code = readCode("confirm-account-email");
      if (!code)
        return Effect.succeed(
          Message.Failed({ error: "Enter the six-digit code." }),
        );
      return request(
        `${emailChangePath}/confirm`,
        { id, code },
        async (response) =>
          Message.EmailChanged(
            Schema.decodeUnknownSync(ChangedEmail)(await response.json()),
          ),
      );
    }),
});

export const ChangePassword = Command.define("ChangeAccountPassword", {
  args: {},
  messages: [Message.PasswordChanged, Message.SignedOut, Message.Failed],
  execute: () =>
    Effect.suspend(() => {
      const element = form("change-account-password");
      if (!element)
        return Effect.succeed(
          Message.Failed({ error: "Could not read the password form." }),
        );
      const fields = new FormData(element);
      const currentPassword = fields.get("current-password");
      const newPassword = fields.get("new-password");
      if (newPassword !== fields.get("confirm-password"))
        return Effect.succeed(
          Message.Failed({ error: "The new passwords do not match." }),
        );

      return request(
        passwordChangePath,
        { currentPassword, newPassword },
        async () => {
          element.reset();
          return Message.PasswordChanged();
        },
      );
    }),
});

const themeLabels = {
  system: "System",
  light: "Light",
  dark: "Dark",
} satisfies Record<ThemePreference, string>;

export const appearanceView = <Parent>(
  saved: ThemePreference,
  appearance: Appearance,
  busy: boolean,
  h: HtmlBuilder<Parent>,
  emit: (message: AppearanceMessage) => Parent,
) => {
  const saving = appearance._tag === "Saving";
  return h.section(
    [h.Class("settings-section"), h.AriaLabelledBy("settings-appearance")],
    [
      h.h2([h.Id("settings-appearance")], ["Appearance"]),
      nativeSelect(
        {
          label: "Theme",
          value: displayedTheme(saved, appearance),
          options: ThemePreference.literals.map((value) => ({
            value,
            label: themeLabels[value],
          })),
          disabled: busy || saving,
          onChange: (value) => emit(AppearanceMessage.SelectedTheme({ value })),
        },
        h,
      ),
      h.p([h.Role("status")], saving ? ["Saving theme…"] : []),
      alert(
        {
          message:
            appearance._tag === "Failed"
              ? "Could not save your theme. Your previous theme has been restored."
              : null,
          severity: "error",
          announcement: "alert",
          action:
            appearance._tag === "Failed"
              ? button(
                  {
                    variant: "outline",
                    size: "sm",
                    disabled: busy,
                    onClick: emit(AppearanceMessage.RetriedTheme()),
                    children: ["Retry"],
                  },
                  h,
                )
              : undefined,
        },
        h,
      ),
    ],
  );
};

export const view = <Parent>(
  account: typeof Account.Type,
  model: Model,
  busy: boolean,
  h: HtmlBuilder<Parent>,
  emit: (message: Message) => Parent,
  signOut: Html,
) => {
  const disabled = busy || model.pending !== null;
  const action = (label: string, message: Message, opensDialog = false) =>
    button(
      {
        variant: "outline",
        size: "sm",
        disabled,
        ...(opensDialog ? { dialogId } : {}),
        onClick: emit(message),
        children: [label],
      },
      h,
    );
  const submit = (label: string) =>
    button(
      {
        type: "submit",
        size: "sm",
        disabled,
        focusableWhenDisabled: true,
        children: [label],
      },
      h,
    );
  const actions = (...children: Html[]) =>
    h.div([h.Class("account-actions")], children);
  const passwordField = (
    name: string,
    label: string,
    autocomplete: "current-password" | "new-password",
    initialFocus: ReadonlyArray<ChildAttribute> = [],
  ) =>
    field(
      label,
      input(
        [
          h.Id(name),
          h.Name(name),
          h.Type("password"),
          h.Autocomplete(autocomplete),
          h.Required(true),
          h.Readonly(disabled),
          ...initialFocus,
        ],
        h,
      ),
      h,
    );
  const codeField = (
    id: string,
    initialFocus: ReadonlyArray<ChildAttribute> = [],
  ) =>
    field(
      "Verification code",
      input(
        [
          h.Id(id),
          h.Name("code"),
          h.Type("text"),
          h.InputMode("numeric"),
          h.Autocomplete("one-time-code"),
          h.Required(true),
          h.Readonly(disabled),
          ...initialFocus,
        ],
        h,
      ),
      h,
    );
  const username = h.input([
    h.Type("hidden"),
    h.Name("username"),
    h.Autocomplete("username"),
    h.Value(account.email),
  ]);
  const cancel = action("Cancel", Message.CloseDialog());
  const canVerify = !account.emailVerified && account.emailDeliveryEnabled;
  const emailForm = (initialFocus: ReadonlyArray<ChildAttribute>) =>
    model.emailChange
      ? h.form(
          [
            h.Class("account-form"),
            h.Id("confirm-account-email"),
            h.Key(`${model.dialog?.key}-confirm`),
            h.Method("post"),
            h.OnSubmit(emit(Message.ConfirmEmailChange())),
          ],
          [
            h.p(
              [h.Role("status")],
              [
                `Enter the code sent to ${model.emailChange.email}. It expires in 5 minutes.`,
              ],
            ),
            codeField("email-change-code", initialFocus),
            Dialog.footer(
              [
                cancel,
                action("Start over", Message.OpenDialog({ dialog: "email" })),
                submit(
                  model.pending === "confirm-email-change"
                    ? "Confirming…"
                    : "Confirm email change",
                ),
              ],
              h,
            ),
          ],
        )
      : h.form(
          [
            h.Class("account-form"),
            h.Id("change-account-email"),
            h.Key(`${model.dialog?.key}-email`),
            h.Method("post"),
            h.OnSubmit(emit(Message.SubmitEmailChange())),
          ],
          [
            h.p(
              [h.Class("account-hint")],
              [
                "After you verify the new address, OneApp will sign out all browsers and notify your old address.",
              ],
            ),
            username,
            field(
              "New email",
              input(
                [
                  h.Id("new-email"),
                  h.Name("new-email"),
                  h.Type("email"),
                  h.Autocomplete("email"),
                  h.Required(true),
                  h.Readonly(disabled),
                  ...initialFocus,
                ],
                h,
              ),
              h,
            ),
            passwordField(
              "email-current-password",
              "Current password",
              "current-password",
            ),
            Dialog.footer(
              [
                cancel,
                submit(
                  model.pending === "send-email-change"
                    ? "Sending…"
                    : "Send code to new email",
                ),
              ],
              h,
            ),
          ],
        );

  const passwordForm = (initialFocus: ReadonlyArray<ChildAttribute>) =>
    h.form(
      [
        h.Class("account-form"),
        h.Id("change-account-password"),
        h.Key(`${model.dialog?.key}-password`),
        h.Method("post"),
        h.OnSubmit(emit(Message.ChangePassword())),
      ],
      [
        h.p(
          [h.Class("account-hint")],
          [
            "Use at least 15 characters. Changing your password signs out all browsers.",
          ],
        ),
        username,
        passwordField(
          "current-password",
          "Current password",
          "current-password",
          initialFocus,
        ),
        passwordField("new-password", "New password", "new-password"),
        passwordField(
          "confirm-password",
          "Confirm new password",
          "new-password",
        ),
        Dialog.footer(
          [
            cancel,
            submit(
              model.pending === "password" ? "Changing…" : "Change password",
            ),
          ],
          h,
        ),
      ],
    );

  return [
    itemGroup(
      [
        item(
          {
            key: "settings-email",
            title: account.email,
            description: h.div(
              [],
              [
                h.div(
                  [h.Role("status")],
                  [
                    account.emailVerified
                      ? "Email verified"
                      : "Email unverified",
                  ],
                ),
                ...(!account.emailDeliveryEnabled
                  ? [
                      h.div(
                        [],
                        ["Email sending is unavailable on this deployment."],
                      ),
                    ]
                  : []),
              ],
            ),
            action: account.emailDeliveryEnabled
              ? actions(
                  ...(canVerify
                    ? [
                        action(
                          model.pending === "send"
                            ? "Sending…"
                            : model.verification
                              ? "Send a new code"
                              : "Send verification code",
                          Message.SendCode(),
                        ),
                      ]
                    : []),
                  action(
                    "Change email",
                    Message.OpenDialog({ dialog: "email" }),
                    true,
                  ),
                )
              : undefined,
          },
          h,
        ),
        item(
          {
            key: "settings-password",
            title: "Password",
            action: action(
              "Change password",
              Message.OpenDialog({ dialog: "password" }),
              true,
            ),
          },
          h,
        ),
      ],
      h,
    ),
    ...(canVerify && model.verification
      ? [
          h.form(
            [
              h.Class("account-form account-verification"),
              h.Id("verify-account-email"),
              h.Method("post"),
              h.OnSubmit(emit(Message.VerifyCode())),
            ],
            [
              h.p(
                [h.Class("account-hint")],
                ["Check your inbox for a code that expires in 5 minutes."],
              ),
              codeField("email-code"),
              submit(
                model.pending === "verify" ? "Verifying…" : "Verify email",
              ),
            ],
          ),
        ]
      : []),
    h.div([h.Class("settings-sign-out")], [signOut]),
    ...(!model.modal.isOpen && model.error
      ? [h.p([h.Role("alert")], [model.error])]
      : []),
    Dialog.view(
      {
        model: model.modal,
        title:
          model.dialog?.kind === "email" ? "Change email" : "Change password",
        showCloseButton: false,
        content: (initialFocus) =>
          h.div(
            [h.Class("account-dialog-content")],
            [
              model.dialog?.kind === "email"
                ? emailForm(initialFocus)
                : passwordForm(initialFocus),
              ...(model.error ? [h.p([h.Role("alert")], [model.error])] : []),
            ],
          ),
        toParentMessage: (message) =>
          emit(Message.GotDialogMessage({ message })),
      },
      h,
    ),
  ];
};
