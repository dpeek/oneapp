import { vaultPath } from "@orumai/core";
import {
  ExtensionApproval,
  ExtensionRequestId,
  extensionAccessPath,
  extensionApprovalHash,
  extensionId,
  ExtensionScope,
  vaultExtensionApprovalHash,
} from "@orumai/core/extension-auth";
import { Effect, Schema } from "effect";
import { Command, Submodel, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { linksPage } from "./navigation.ts";

export const Model = Schema.Struct({
  approvalId: Schema.NullOr(ExtensionRequestId),
  scope: ExtensionScope,
  approved: Schema.Boolean,
  pending: Schema.Boolean,
  error: Schema.String,
});
type Model = typeof Model.Type;

export function initial(): Model {
  const hash = window.location.hash;
  const vault = hash.startsWith(vaultExtensionApprovalHash);
  const prefix = vault ? vaultExtensionApprovalHash : extensionApprovalHash;
  const id = hash.startsWith(prefix) ? hash.slice(prefix.length) : null;
  return {
    approvalId: Schema.is(ExtensionRequestId)(id) ? id : null,
    scope: vault ? "vault-read" : "links",
    approved: false,
    pending: false,
    error: "",
  };
}

export const Message = defineMessageUnion({
  RequestedApproval: {},
  Approved: {},
  Failed: { error: Schema.String },
});
type Message = typeof Message.Type;

const csrf = { "x-effect-auth-csrf": "1" };
const fail = (error: string) => () => Effect.succeed(Message.Failed({ error }));
const isApproval = Schema.is(ExtensionApproval);

const Approve = Command.define("ApproveChromeExtension", {
  args: { id: ExtensionRequestId, scope: ExtensionScope },
  messages: [Message.Approved, Message.Failed],
  execute: ({ id, scope }) =>
    Effect.tryPromise(async (signal) => {
      const runtime =
        typeof chrome === "undefined" ? undefined : chrome.runtime;
      if (!runtime?.sendMessage)
        return Message.Failed({
          error:
            "Open the connection page from the Orumai extension in Chrome.",
        });

      const approval = await new Promise<unknown>((resolve) => {
        runtime.sendMessage(
          extensionId,
          { type: "approve-oneapp-extension", id, scope },
          (value) => {
            resolve(runtime.lastError ? null : value);
          },
        );
      });
      if (
        !isApproval(approval) ||
        approval.id !== id ||
        (approval.scope ?? "links") !== scope
      ) {
        return Message.Failed({
          error:
            "This connection request is unavailable or expired. Open a new request from the extension.",
        });
      }

      const response = await fetch(extensionAccessPath, {
        method: "POST",
        headers: { ...csrf, "content-type": "application/json" },
        body: JSON.stringify(approval),
        signal,
      });
      if (response.status === 409)
        return Message.Failed({
          error:
            "This request has already been used. Check the connection in the extension.",
        });
      if (response.status === 401)
        return Message.Failed({
          error: "Your session expired. Reload the page to sign in.",
        });
      if (response.status !== 204)
        throw new Error("Could not approve the extension");
      const prefix =
        scope === "vault-read"
          ? vaultExtensionApprovalHash
          : extensionApprovalHash;
      if (window.location.hash === prefix + id)
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search,
        );
      return Message.Approved();
    }).pipe(
      Effect.catch(
        fail(
          "Could not connect the extension. Check the connection in Chrome before trying again.",
        ),
      ),
    ),
});

export const update = (model: Model, message: Message) => {
  const pending = { ...model, pending: true, error: "" };
  return Message.match<Update.Return<Model, Message>>(message, {
    RequestedApproval: () =>
      model.pending || !model.approvalId
        ? { model }
        : {
            model: pending,
            commands: [Approve({ id: model.approvalId, scope: model.scope })],
          },
    Approved: () => ({
      model: { ...model, approvalId: null, approved: true, pending: false },
    }),
    Failed: ({ error }) => ({ model: { ...model, pending: false, error } }),
  });
};

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const vault = model.scope === "vault-read";
  const button = (label: string, message: Message) =>
    h.button(
      [h.Type("button"), h.Disabled(model.pending), h.OnClick(message)],
      [label],
    );
  return h.section(
    [h.Id("extension-access")],
    [
      h.h2(
        [],
        [
          vault
            ? "Connect the Orumai extension to your vault"
            : "Connect the Orumai extension",
        ],
      ),
      ...(model.approvalId
        ? [
            h.p(
              [],
              [
                vault
                  ? "Allow this Chrome extension to read encrypted login records. Unlocking and matching happen in Chrome. You can revoke access in Settings under Connected clients."
                  : "Allow this Chrome extension to save links to your account until you revoke access.",
              ],
            ),
            button(
              vault ? "Allow read-only vault access" : "Connect",
              Message.RequestedApproval(),
            ),
          ]
        : []),
      h.p(
        [h.Role("status")],
        [
          model.approved
            ? vault
              ? "Vault access approved. Reopen the extension on the tab you want to sign in to."
              : "Extension connected. You can return to the tab you want to save."
            : "",
        ],
      ),
      h.p([h.Role("alert")], [model.error]),
      ...(model.approved
        ? [
            h.a(
              [h.Href(vault ? vaultPath : linksPage)],
              [vault ? "Open Vault" : "Back to Links"],
            ),
          ]
        : []),
    ],
  );
});
