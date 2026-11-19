import { Effect, Schema } from "effect";
import { Command, Submodel, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { vaultReader } from "./vault-reader.ts";
import {
  vaultPasswordMaximum,
  vaultPasswordMinimum,
  vaultSetupPath,
  VaultSetupStatus,
} from "./vault-setup-contract.ts";
import { createVaultSetup } from "./vault-crypto.ts";

const formId = "vault-setup";
const passwordId = "vault-master-password";
const confirmationId = "vault-confirm-master-password";
const helpId = "vault-password-help";

export const Model = Schema.Struct({
  status: Schema.NullOr(VaultSetupStatus),
  pending: Schema.Boolean,
  error: Schema.String,
});
type Model = typeof Model.Type;
export const initial: Model = { status: null, pending: false, error: "" };

export const Message = defineMessageUnion({
  Requested: {},
  Submitted: {},
  Loaded: { status: VaultSetupStatus },
  AlreadyInitialized: {},
  Failed: { error: Schema.String, reload: Schema.Boolean },
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
        });
      if (password !== confirmation)
        return Message.Failed({
          error: "The master passwords must match.",
          reload: false,
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
            model: { ...model, pending: true, error: "" },
            commands: [Load({})],
          },
    Submitted: () =>
      model.pending || !model.status || model.status.initialized
        ? { model }
        : {
            model: { ...model, pending: true, error: "" },
            commands: [Create({ kdfSalt: model.status.kdfSalt })],
          },
    Loaded: ({ status }) => ({ model: { status, pending: false, error: "" } }),
    AlreadyInitialized: () => ({
      model: {
        status: { initialized: true },
        pending: false,
        error:
          "A vault already exists. Use the master password chosen when it was created.",
      },
    }),
    Failed: ({ error, reload }) => ({
      model: { status: reload ? null : model.status, pending: false, error },
    }),
  });

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.section(
    [h.Class("vault-setup"), h.AriaBusy(model.pending)],
    [
      ...(model.status === null
        ? model.pending || !model.error
          ? [h.p([h.Role("status")], ["Checking vault status…"])]
          : [
              h.button(
                [h.Type("button"), h.OnClick(Message.Requested())],
                ["Check vault status"],
              ),
            ]
        : model.status.initialized
          ? [h.h2([], ["Your vault is ready"]), vaultReader.withMessage(h)()]
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
                  h.Method("post"),
                  h.OnSubmit(Message.Submitted()),
                ],
                [
                  h.div(
                    [h.Class("vault-password-field")],
                    [
                      h.label([h.For(passwordId)], ["Vault master password"]),
                      h.input([
                        h.Id(passwordId),
                        h.Type("password"),
                        h.Autocomplete("new-password"),
                        h.Minlength(vaultPasswordMinimum),
                        h.Maxlength(vaultPasswordMaximum),
                        h.AriaDescribedBy(helpId),
                        h.Required(true),
                        h.Readonly(model.pending),
                      ]),
                    ],
                  ),
                  h.div(
                    [h.Class("vault-password-field")],
                    [
                      h.label(
                        [h.For(confirmationId)],
                        ["Confirm vault master password"],
                      ),
                      h.input([
                        h.Id(confirmationId),
                        h.Type("password"),
                        h.Autocomplete("new-password"),
                        h.Minlength(vaultPasswordMinimum),
                        h.Maxlength(vaultPasswordMaximum),
                        h.Required(true),
                        h.Readonly(model.pending),
                      ]),
                    ],
                  ),
                  h.button(
                    [h.Type("submit"), h.Disabled(model.pending)],
                    [model.pending ? "Creating vault…" : "Create vault"],
                  ),
                ],
              ),
            ]),
      ...(model.error ? [h.p([h.Role("alert")], [model.error])] : []),
    ],
  ),
);
