import { button, dialog, field, input, item, itemGroup } from "@oneapp/ui";
import { Effect, Option, Schema } from "effect";
import { Command } from "foldkit";
import { focus } from "foldkit/dom";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
import {
  ChangedEmail,
  emailChangePath,
  EmailVerification,
  emailVerificationPath,
  passwordChangePath,
  PendingEmailChange,
} from "./account-contract.ts";
import type { Account } from "./auth-contract.ts";

const Dialog = Schema.Literals(["email", "password"]);

export const Model = Schema.Struct({
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
  dialog: Schema.NullOr(Dialog),
  emailChange: Schema.NullOr(PendingEmailChange),
  error: Schema.String,
});
type Model = typeof Model.Type;
export const initial: Model = {
  pending: null,
  verification: null,
  dialog: null,
  emailChange: null,
  error: "",
};

export const Message = defineMessageUnion({
  SendCode: {},
  VerifyCode: {},
  ChangePassword: {},
  OpenDialog: { dialog: Dialog },
  CloseDialog: {},
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

const ShowDialog = Mount.define("ShowAccountDialog", {
  messages: [Message.DialogUpdated],
  execute: ({ element }) =>
    Effect.sync(() => {
      if (element instanceof HTMLDialogElement && !element.open)
        element.showModal();
      return Message.DialogUpdated();
    }),
});

export const FocusElement = Command.define("FocusAccountElement", {
  args: { selector: Schema.String },
  messages: [Message.DialogUpdated],
  execute: ({ selector }) =>
    focus(selector).pipe(Effect.ignore, Effect.as(Message.DialogUpdated())),
});

const request = <Success extends Message>(
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

export const view = <Parent>(
  account: typeof Account.Type,
  model: Model,
  busy: boolean,
  h: HtmlBuilder<Parent>,
  emit: (message: Message) => Parent,
  signOut: Html,
) => {
  const disabled = busy || model.pending !== null;
  const action = (label: string, message: Message, id?: string) =>
    button(
      {
        variant: "outline",
        size: "sm",
        disabled,
        attributes: id ? [h.Id(id), h.AriaHasPopup("dialog")] : [],
        onClick: emit(message),
        children: [label],
      },
      h,
    );
  const submit = (label: string) =>
    button({ type: "submit", size: "sm", disabled, children: [label] }, h);
  const actions = (...children: Html[]) =>
    h.div([h.Class("account-actions")], children);
  const passwordField = (
    name: string,
    label: string,
    autocomplete: "current-password" | "new-password",
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
        ],
        h,
      ),
      h,
    );
  const codeField = (id: string) =>
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
  const emailForm = model.emailChange
    ? h.form(
        [
          h.Class("account-form"),
          h.Id("confirm-account-email"),
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
          codeField("email-change-code"),
          actions(
            cancel,
            action("Start over", Message.OpenDialog({ dialog: "email" })),
            submit(
              model.pending === "confirm-email-change"
                ? "Confirming…"
                : "Confirm email change",
            ),
          ),
        ],
      )
    : h.form(
        [
          h.Class("account-form"),
          h.Id("change-account-email"),
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
          actions(
            cancel,
            submit(
              model.pending === "send-email-change"
                ? "Sending…"
                : "Send code to new email",
            ),
          ),
        ],
      );

  const passwordForm = h.form(
    [
      h.Class("account-form"),
      h.Id("change-account-password"),
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
      passwordField("current-password", "Current password", "current-password"),
      passwordField("new-password", "New password", "new-password"),
      passwordField("confirm-password", "Confirm new password", "new-password"),
      actions(
        cancel,
        submit(model.pending === "password" ? "Changing…" : "Change password"),
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
                    "open-email-dialog",
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
              "open-password-dialog",
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
    ...(model.dialog
      ? [
          dialog(
            {
              titleId: "account-dialog-title",
              title:
                model.dialog === "email" ? "Change email" : "Change password",
              attributes: [
                h.Key(model.dialog),
                h.OnMount(Mount.mapMessage(ShowDialog(), emit)),
                h.OnKeyDownPreventDefault((key) =>
                  key === "Escape"
                    ? Option.some(emit(Message.CloseDialog()))
                    : Option.none(),
                ),
                h.OnCancel(emit(Message.CloseDialog())),
              ],
              children: [
                model.dialog === "email" ? emailForm : passwordForm,
                ...(model.error ? [h.p([h.Role("alert")], [model.error])] : []),
              ],
            },
            h,
          ),
        ]
      : model.error
        ? [h.p([h.Role("alert")], [model.error])]
        : []),
  ];
};
