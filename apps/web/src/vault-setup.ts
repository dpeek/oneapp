import { alert, button, field, input } from "@oneapp/ui";
import { Effect, Schema } from "effect";
import { Command, Submodel, type Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { vaultReader } from "./vault-reader.ts";
import {
  vaultPasswordMaximum,
  vaultPasswordMinimum,
  vaultSetupPath,
  VaultSetupStatus,
} from "./vault-setup-contract.ts";
import { createVaultSetup } from "./vault-crypto.ts";
import { screenHeader } from "./workspace.ts";

const formId = "vault-setup";
const passwordId = "vault-master-password";
const confirmationId = "vault-confirm-master-password";
const helpId = "vault-password-help";
const PasswordField = Schema.Literals(["password", "confirmation"]);

export const Model = Schema.Struct({
  status: Schema.NullOr(VaultSetupStatus),
  pending: Schema.Boolean,
  error: Schema.NullOr(
    Schema.Struct({
      message: Schema.String,
      field: Schema.optionalKey(PasswordField),
    }),
  ),
});
type Model = typeof Model.Type;
export const initial: Model = { status: null, pending: false, error: null };

export const Message = defineMessageUnion({
  Requested: {},
  Submitted: {},
  Loaded: { status: VaultSetupStatus },
  AlreadyInitialized: {},
  Failed: {
    error: Schema.String,
    reload: Schema.Boolean,
    field: Schema.optionalKey(PasswordField),
  },
});
type Message = typeof Message.Type;

const Load = Command.define("LoadVaultSetup", {
  args: {},
  messages: [Message.Loaded, Message.Failed],
  execute: () =>
    Effect.tryPromise(async () => {
      const response = await fetch(vaultSetupPath, { cache: "no-store" });
      if (!response.ok) throw new Error("Vault status unavailable");
      return Message.Loaded({
        status: Schema.decodeUnknownSync(VaultSetupStatus)(
          await response.json(),
        ),
      });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          Message.Failed({
            error: "Could not load your vault status.",
            reload: true,
          }),
        ),
      ),
    ),
});

const Create = Command.define("CreateVault", {
  args: { kdfSalt: Schema.String },
  messages: [Message.Loaded, Message.AlreadyInitialized, Message.Failed],
  execute: ({ kdfSalt }) =>
    Effect.tryPromise(async () => {
      const form = document.getElementById(formId);
      const passwordInput = document.getElementById(passwordId);
      const confirmationInput = document.getElementById(confirmationId);
      if (
        !(form instanceof HTMLFormElement) ||
        !(passwordInput instanceof HTMLInputElement) ||
        !(confirmationInput instanceof HTMLInputElement)
      )
        return Message.Failed({
          error: "Could not read the vault setup form.",
          reload: false,
        });

      // Unnamed inputs keep secrets out of native form submissions as well as Foldkit state.
      const password = passwordInput.value;
      const confirmation = confirmationInput.value;
      if (
        password.length < vaultPasswordMinimum ||
        password.length > vaultPasswordMaximum ||
        !password.trim()
      )
        return Message.Failed({
          error: `Use a master password between ${vaultPasswordMinimum} and ${vaultPasswordMaximum} characters.`,
          reload: false,
          field: "password",
        });
      if (password !== confirmation)
        return Message.Failed({
          error: "The master passwords must match.",
          reload: false,
          field: "confirmation",
        });
      form.reset();

      const keys = await createVaultSetup(password, kdfSalt);
      const response = await fetch(vaultSetupPath, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-effect-auth-csrf": "1",
        },
        body: JSON.stringify(keys),
      });
      if (response.status === 409) return Message.AlreadyInitialized();
      if (!response.ok) throw new Error("Vault setup failed");
      return Message.Loaded({ status: { initialized: true } });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          Message.Failed({
            error:
              "Could not confirm vault setup. Check the vault status before trying again.",
            reload: true,
          }),
        ),
      ),
    ),
});

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    Requested: () =>
      model.pending || model.status
        ? { model }
        : {
            model: { ...model, pending: true, error: null },
            commands: [Load({})],
          },
    Submitted: () =>
      model.pending || !model.status || model.status.initialized
        ? { model }
        : {
            model: { ...model, pending: true, error: null },
            commands: [Create({ kdfSalt: model.status.kdfSalt })],
          },
    Loaded: ({ status }) => ({
      model: { status, pending: false, error: null },
    }),
    AlreadyInitialized: () => ({
      model: {
        status: { initialized: true },
        pending: false,
        error: {
          message:
            "A vault already exists. Use the master password chosen when it was created.",
        },
      },
    }),
    Failed: ({ error, reload, field }) => ({
      model: {
        status: reload ? null : model.status,
        pending: false,
        error: { message: error, ...(field ? { field } : {}) },
      },
    }),
  });

const passwordField = (
  kind: typeof PasswordField.Type,
  model: Model,
  h: HtmlBuilder<Message>,
) => {
  const first = kind === "password";
  const id = first ? passwordId : confirmationId;
  const label = first
    ? "Vault master password"
    : "Confirm vault master password";
  const error = model.error?.field === kind ? model.error.message : null;
  const errorId = `${id}-error`;
  const description = [first ? helpId : null, error ? errorId : null]
    .filter(Boolean)
    .join(" ");
  return h.div(
    [h.Class("vault-setup-field")],
    [
      field(
        label,
        input(
          [
            h.Id(id),
            h.Type("password"),
            h.Autocomplete("new-password"),
            h.Minlength(vaultPasswordMinimum),
            h.Maxlength(vaultPasswordMaximum),
            ...(description ? [h.AriaDescribedBy(description)] : []),
            ...(error ? [h.AriaInvalid(true)] : []),
            h.Required(true),
            h.Readonly(model.pending),
          ],
          h,
        ),
        h,
      ),
      alert(
        {
          message: error,
          messageId: errorId,
          severity: "error",
          announcement: "alert",
        },
        h,
      ),
    ],
  );
};

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.section(
    [
      h.Class(
        model.status?.initialized
          ? "vault-setup vault-initialized"
          : "vault-setup",
      ),
      h.AriaBusy(model.pending),
    ],
    [
      screenHeader({ title: "Vault" }, h),
      ...(model.status === null
        ? model.pending || !model.error
          ? [h.p([h.Role("status")], ["Checking vault status…"])]
          : []
        : model.status.initialized
          ? [vaultReader.withMessage(h)()]
          : [
              h.h2([], ["Set up your vault"]),
              h.p(
                [h.Id(helpId)],
                [
                  `Choose a separate master password with at least ${vaultPasswordMinimum} characters. You’ll need it to unlock your vault.`,
                ],
              ),
              h.form(
                [
                  h.Id(formId),
                  h.Class("vault-setup-form"),
                  h.Method("post"),
                  h.OnSubmit(Message.Submitted()),
                ],
                [
                  passwordField("password", model, h),
                  passwordField("confirmation", model, h),
                  button(
                    {
                      type: "submit",
                      disabled: model.pending,
                      focusableWhenDisabled: model.pending,
                      children: [
                        model.pending ? "Creating vault…" : "Create vault",
                      ],
                    },
                    h,
                  ),
                ],
              ),
            ]),
      alert(
        {
          message:
            model.error && !model.error.field ? model.error.message : null,
          severity: "error",
          announcement: "alert",
          action:
            model.status === null && !model.pending
              ? button(
                  {
                    variant: "outline",
                    size: "sm",
                    onClick: Message.Requested(),
                    children: ["Check vault status"],
                  },
                  h,
                )
              : undefined,
        },
        h,
      ),
    ],
  ),
);
