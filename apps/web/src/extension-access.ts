import {
  ExtensionAccessList,
  ExtensionApproval,
  ExtensionRequestId,
  extensionAccessPath,
  extensionApprovalHash,
  extensionId,
} from "@oneapp/core/extension-auth";
import { Effect, Schema } from "effect";
import { Command, Submodel, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";

export const Model = Schema.Struct({
  approvalId: Schema.NullOr(ExtensionRequestId),
  approved: Schema.Boolean,
  connections: Schema.NullOr(ExtensionAccessList),
  pending: Schema.Boolean,
  error: Schema.String,
});
type Model = typeof Model.Type;

export function initial(): Model {
  const hash = window.location.hash;
  const id = hash.startsWith(extensionApprovalHash)
    ? hash.slice(extensionApprovalHash.length)
    : null;
  return {
    approvalId: Schema.is(ExtensionRequestId)(id) ? id : null,
    approved: false,
    connections: null,
    pending: false,
    error: "",
  };
}

export const Message = defineMessageUnion({
  RequestedApproval: {},
  RequestedConnections: {},
  RequestedRevocation: { id: ExtensionRequestId },
  Approved: {},
  Loaded: { connections: ExtensionAccessList },
  Revoked: { id: ExtensionRequestId },
  Failed: { error: Schema.String },
});
type Message = typeof Message.Type;

const csrf = { "x-effect-auth-csrf": "1" };
const date = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const fail = (error: string) => () => Effect.succeed(Message.Failed({ error }));
const isApproval = Schema.is(ExtensionApproval);

const Approve = Command.define("ApproveChromeExtension", {
  args: { id: ExtensionRequestId },
  messages: [Message.Approved, Message.Failed],
  execute: ({ id }) =>
    Effect.tryPromise(async (signal) => {
      const runtime =
        typeof chrome === "undefined" ? undefined : chrome.runtime;
      if (!runtime?.sendMessage)
        return Message.Failed({
          error:
            "Open the connection page from the OneApp extension in Chrome.",
        });

      const approval = await new Promise<unknown>((resolve) => {
        runtime.sendMessage(
          extensionId,
          { type: "approve-oneapp-extension", id },
          (value) => {
            resolve(runtime.lastError ? null : value);
          },
        );
      });
      if (!isApproval(approval) || approval.id !== id) {
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
      if (window.location.hash === extensionApprovalHash + id)
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

const Load = Command.define("LoadExtensionAccess", {
  args: {},
  messages: [Message.Loaded, Message.Failed],
  execute: () =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(extensionAccessPath, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error("Could not load extension access");
      return Message.Loaded({
        connections: Schema.decodeUnknownSync(ExtensionAccessList)(
          await response.json(),
        ),
      });
    }).pipe(Effect.catch(fail("Could not load extension access. Try again."))),
});

const Revoke = Command.define("RevokeExtensionAccess", {
  args: { id: ExtensionRequestId },
  messages: [Message.Revoked, Message.Failed],
  execute: ({ id }) =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(`${extensionAccessPath}/${id}`, {
        method: "DELETE",
        headers: csrf,
        signal,
      });
      if (response.status !== 204)
        throw new Error("Could not revoke extension access");
      return Message.Revoked({ id });
    }).pipe(
      Effect.catch(fail("Could not revoke extension access. Try again.")),
    ),
});

export const update = (model: Model, message: Message) => {
  const pending = { ...model, pending: true, error: "" };
  return Message.match<Update.Return<Model, Message>>(message, {
    RequestedApproval: () =>
      model.pending || !model.approvalId
        ? { model }
        : { model: pending, commands: [Approve({ id: model.approvalId })] },
    RequestedConnections: () =>
      model.pending ? { model } : { model: pending, commands: [Load({})] },
    RequestedRevocation: ({ id }) =>
      model.pending
        ? { model }
        : { model: pending, commands: [Revoke({ id })] },
    Approved: () => ({
      model: { ...model, approvalId: null, approved: true },
      commands: [Load({})],
    }),
    Loaded: ({ connections }) => ({
      model: { ...model, connections, pending: false },
    }),
    Revoked: ({ id }) => ({
      model: {
        ...model,
        connections:
          model.connections?.filter((connection) => connection.id !== id) ??
          null,
        pending: false,
      },
    }),
    Failed: ({ error }) => ({ model: { ...model, pending: false, error } }),
  });
};

export const view = Submodel.defineView<Model, Message>((model, h) => {
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
          model.approvalId
            ? "Connect the OneApp extension"
            : "Extension access",
        ],
      ),
      ...(model.approvalId
        ? [
            h.p(
              [],
              [
                "Allow this Chrome extension to save links to your account until you revoke access.",
              ],
            ),
            button("Connect", Message.RequestedApproval()),
          ]
        : model.connections === null
          ? [button("Manage extension access", Message.RequestedConnections())]
          : model.connections.length === 0
            ? [h.p([], ["No connected extensions."])]
            : [
                h.ul(
                  [h.Class("cli-tokens")],
                  model.connections.map((connection) =>
                    h.li(
                      [h.Key(connection.id)],
                      [
                        h.div(
                          [],
                          [
                            h.strong([], ["Chrome extension"]),
                            h.div(
                              [],
                              [
                                `Connected ${date.format(connection.createdAt)}`,
                              ],
                            ),
                            h.div(
                              [],
                              [
                                connection.expiresAt === null
                                  ? "Active until revoked"
                                  : `Expires ${date.format(connection.expiresAt)}`,
                              ],
                            ),
                          ],
                        ),
                        button(
                          "Revoke extension",
                          Message.RequestedRevocation({ id: connection.id }),
                        ),
                      ],
                    ),
                  ),
                ),
              ]),
      h.p(
        [h.Role("status")],
        [
          model.approved
            ? "Extension connected. You can return to the tab you want to save."
            : "",
        ],
      ),
      h.p([h.Role("alert")], [model.error]),
    ],
  );
});
