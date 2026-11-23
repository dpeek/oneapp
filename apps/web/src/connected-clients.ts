import { button, item, itemGroup, outlineIcon, spinner } from "@oneapp/ui";
import { CliTokenList, cliTokensPath } from "@oneapp/core/cli-auth";
import {
  ExtensionAccessList,
  extensionAccessPath,
} from "@oneapp/core/extension-auth";
import { Effect, Schema } from "effect";
import { Command, Submodel, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { Notification } from "./notifications.ts";
import {
  BitwardenDeviceList,
  bitwardenDevicesPath,
} from "./bitwarden-device-contract.ts";
import {
  codexClientId,
  isCodexMetadataId,
  McpGrantList,
  mcpGrantsPath,
} from "./mcp-access-contract.ts";

const ClientType = Schema.Literals(["CLI", "Extension", "MCP", "Bitwarden"]);
type ClientType = typeof ClientType.Type;
const Connection = Schema.Struct({
  type: ClientType,
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.Int,
});
type Connection = typeof Connection.Type;
const Connections = Schema.Array(Connection);
const ClientTypes = Schema.Array(ClientType);

export const Model = Schema.Struct({
  connections: Schema.NullOr(Connections),
  unavailable: ClientTypes,
  request: Schema.NullOr(
    Schema.Union([
      Schema.TaggedStruct("Load", { id: Schema.String }),
      Schema.TaggedStruct("Revoke", {
        id: Schema.String,
        connection: Connection,
      }),
    ]),
  ),
  error: Schema.String,
});
type Model = typeof Model.Type;

export const initial: Model = {
  connections: null,
  unavailable: [],
  request: null,
  error: "",
};

const ConnectionKey = { type: ClientType, id: Schema.String };
export const Message = defineMessageUnion({
  Requested: {},
  Loaded: {
    request: Schema.String,
    connections: Connections,
    unavailable: ClientTypes,
  },
  RequestedRevocation: ConnectionKey,
  Revoked: { ...ConnectionKey, request: Schema.String },
  Failed: { request: Schema.String, error: Schema.String },
  SessionExpired: { request: Schema.String },
});
type Message = typeof Message.Type;
export const OutMessage = defineMessageUnion({
  Notify: { notification: Notification },
  DismissNotification: { key: Schema.String },
  SessionExpired: {},
});
export type OutMessage = typeof OutMessage.Type;
const notificationKey = (connection: Connection) =>
  `client-revoke:${connection.type}:${connection.id}`;

const paths = {
  CLI: cliTokensPath,
  Extension: extensionAccessPath,
  MCP: mcpGrantsPath,
  Bitwarden: bitwardenDevicesPath,
};

const readConnections = async (
  type: ClientType,
  signal: AbortSignal,
): Promise<readonly Connection[]> => {
  const response = await fetch(paths[type], { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Could not load ${type} connections`);
  const body: unknown = await response.json();
  switch (type) {
    case "CLI":
      return Schema.decodeUnknownSync(CliTokenList)(body).map(
        ({ id, createdAt, label }) => ({ id, createdAt, type, name: label }),
      );
    case "Extension":
      return Schema.decodeUnknownSync(ExtensionAccessList)(body).map(
        ({ id, createdAt }) => ({
          id,
          createdAt,
          type,
          name: "Chrome extension",
        }),
      );
    case "MCP":
      return Schema.decodeUnknownSync(McpGrantList)(body).map(
        ({ id, createdAt, clientId }) => ({
          id,
          createdAt,
          type,
          name:
            clientId === codexClientId || isCodexMetadataId(clientId)
              ? "Codex"
              : clientId,
        }),
      );
    case "Bitwarden":
      return Schema.decodeUnknownSync(BitwardenDeviceList)(body).map(
        ({ id, name, createdAt }) => ({
          id,
          createdAt,
          type,
          name: `${name} · ${id.slice(-8).toUpperCase()}`,
        }),
      );
  }
};

const Load = Command.define("LoadConnectedClients", {
  args: { request: Schema.String },
  messages: [Message.Loaded],
  execute: ({ request }) =>
    Effect.promise(async (signal) => {
      const results = await Promise.all(
        ClientType.literals.map((type) =>
          readConnections(type, signal).then(
            (connections) => ({ type, connections }),
            () => ({ type, connections: null }),
          ),
        ),
      );
      const connections: Connection[] = [];
      const unavailable: ClientType[] = [];
      for (const result of results) {
        if (result.connections) connections.push(...result.connections);
        else unavailable.push(result.type);
      }
      return Message.Loaded({ request, connections, unavailable });
    }),
});

const Revoke = Command.define("RevokeConnectedClient", {
  args: { ...ConnectionKey, request: Schema.String },
  messages: [Message.Revoked, Message.Failed, Message.SessionExpired],
  execute: ({ type, id, request }) =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(`${paths[type]}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "x-effect-auth-csrf": "1" },
        signal,
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      if (response.status !== 204)
        throw new Error(`Could not revoke ${type} access`);
      return Message.Revoked({ type, id, request });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          Message.Failed({
            request,
            error: `Could not revoke ${type} access. Try again.`,
          }),
        ),
      ),
    ),
});

export const update = (model: Model, message: Message, visible = true) =>
  Message.match<Update.ReturnWithOutMessage<Model, Message, OutMessage>>(
    message,
    {
      Requested: () => {
        if (model.request) return { model };
        const request = crypto.randomUUID();
        return {
          model: {
            ...model,
            request: { _tag: "Load", id: request },
            error: "",
          },
          commands: [Load({ request })],
        };
      },
      Loaded: ({ request, connections, unavailable }) => {
        if (model.request?._tag !== "Load" || model.request.id !== request)
          return { model };
        return {
          model: {
            ...model,
            connections: [
              ...connections,
              ...(model.connections ?? []).filter(({ type }) =>
                unavailable.includes(type),
              ),
            ].sort((a, b) => b.createdAt - a.createdAt),
            unavailable,
            request: null,
          },
        };
      },
      RequestedRevocation: ({ type, id }) => {
        const connection = model.connections?.find(
          (item) => item.type === type && item.id === id,
        );
        if (model.request || !connection) return { model };
        const request = crypto.randomUUID();
        return {
          model: {
            ...model,
            request: { _tag: "Revoke", id: request, connection },
            error: "",
          },
          commands: [Revoke({ type, id, request })],
        };
      },
      Revoked: ({ request, type, id }) => {
        const pending = model.request;
        if (
          pending?._tag !== "Revoke" ||
          pending.id !== request ||
          pending.connection.type !== type ||
          pending.connection.id !== id
        )
          return { model };
        return {
          model: {
            ...model,
            connections:
              model.connections?.filter(
                (item) => item.type !== type || item.id !== id,
              ) ?? null,
            request: null,
            error: "",
          },
          outMessage: OutMessage.DismissNotification({
            key: notificationKey(pending.connection),
          }),
        };
      },
      Failed: ({ request, error }) => {
        const pending = model.request;
        if (pending?._tag !== "Revoke" || pending.id !== request)
          return { model };
        return {
          model: { ...model, request: null, error: visible ? error : "" },
          ...(visible
            ? {
                outMessage: OutMessage.DismissNotification({
                  key: notificationKey(pending.connection),
                }),
              }
            : {
                outMessage: OutMessage.Notify({
                  notification: {
                    key: notificationKey(pending.connection),
                    variant: "Error",
                    title: error,
                    description: pending.connection.name,
                  },
                }),
              }),
        };
      },
      SessionExpired: ({ request }) =>
        model.request?.id === request
          ? { model, outMessage: OutMessage.SessionExpired() }
          : { model },
    },
  );

const headingId = "connected-clients-heading";
const clientIcons = {
  CLI: ["m5 7 5 5-5 5m8 0h6"],
  Extension: ["M3 5h18v14H3zM3 9h18m-14 6h6"],
  MCP: ["M4 8h16v8H4zm4 4h2m4 0h2M12 4v4m0 8v4"],
  Bitwarden: ["M12 22s7-3 7-9V5l-7-3-7 3v8c0 6 7 9 7 9Z"],
} satisfies Record<ClientType, readonly string[]>;

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.section(
    [h.Class("settings-section"), h.AriaLabelledBy(headingId)],
    [
      h.h2([h.Id(headingId)], ["Clients"]),
      h.p(
        [h.Id("cli-access"), h.Class("account-hint")],
        ["Run ", h.code([], ["one auth login"]), " to connect a CLI device."],
      ),
      ...(model.connections === null
        ? [
            h.div(
              [h.Class("settings-loading")],
              [spinner("Loading connections…", h)],
            ),
          ]
        : model.connections.length > 0
          ? [
              itemGroup(
                model.connections.map(({ name, type, id }) =>
                  item(
                    {
                      key: `client-${type}:${id}`,
                      title: name,
                      description: h.span([], [type]),
                      media: h.span(
                        [h.Class("settings-client-icon")],
                        [outlineIcon(h, clientIcons[type])],
                      ),
                      action: button(
                        {
                          size: "sm",
                          variant: "ghost",
                          disabled: model.request !== null,
                          ariaLabel: `Revoke ${name} access`,
                          onClick: Message.RequestedRevocation({ type, id }),
                          children: ["Revoke"],
                        },
                        h,
                      ),
                    },
                    h,
                  ),
                ),
                h,
              ),
            ]
          : model.unavailable.length === 0
            ? [h.p([h.Class("account-hint")], ["No connected clients."])]
            : []),
      ...(model.unavailable.length > 0
        ? [
            h.p(
              [h.Role("alert")],
              [
                `Could not load connections for ${model.unavailable.join(", ")}.`,
              ],
            ),
            h.div(
              [],
              [
                button(
                  {
                    size: "sm",
                    variant: "outline",
                    disabled: model.request !== null,
                    onClick: Message.Requested(),
                    children: ["Retry loading connections"],
                  },
                  h,
                ),
              ],
            ),
          ]
        : []),
      ...(model.error ? [h.p([h.Role("alert")], [model.error])] : []),
    ],
  ),
);
