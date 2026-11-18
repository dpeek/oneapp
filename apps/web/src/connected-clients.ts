import { CliTokenList, cliTokensPath } from "@oneapp/core/cli-auth";
import {
  ExtensionAccessList,
  extensionAccessPath,
} from "@oneapp/core/extension-auth";
import { Effect, Schema } from "effect";
import { Command, Submodel, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
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
  pending: Schema.Boolean,
  error: Schema.String,
});
type Model = typeof Model.Type;

export const initial: Model = {
  connections: null,
  unavailable: [],
  pending: false,
  error: "",
};

const ConnectionKey = { type: ClientType, id: Schema.String };
export const Message = defineMessageUnion({
  Requested: {},
  Loaded: { connections: Connections, unavailable: ClientTypes },
  RequestedRevocation: ConnectionKey,
  Revoked: ConnectionKey,
  Failed: { error: Schema.String },
});
type Message = typeof Message.Type;

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
  args: {},
  messages: [Message.Loaded],
  execute: () =>
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
      return Message.Loaded({ connections, unavailable });
    }),
});

const Revoke = Command.define("RevokeConnectedClient", {
  args: ConnectionKey,
  messages: [Message.Revoked, Message.Failed],
  execute: ({ type, id }) =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(`${paths[type]}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "x-effect-auth-csrf": "1" },
        signal,
      });
      if (response.status !== 204)
        throw new Error(`Could not revoke ${type} access`);
      return Message.Revoked({ type, id });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          Message.Failed({
            error: `Could not revoke ${type} access. Try again.`,
          }),
        ),
      ),
    ),
});

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    Requested: () =>
      model.pending
        ? { model }
        : {
            model: { ...model, pending: true, error: "" },
            commands: [Load({})],
          },
    Loaded: ({ connections, unavailable }) => ({
      model: {
        ...model,
        connections: [
          ...connections,
          ...(model.connections ?? []).filter(({ type }) =>
            unavailable.includes(type),
          ),
        ].sort((a, b) => b.createdAt - a.createdAt),
        unavailable,
        pending: false,
      },
    }),
    RequestedRevocation: ({ type, id }) =>
      model.pending
        ? { model }
        : {
            model: { ...model, pending: true, error: "" },
            commands: [Revoke({ type, id })],
          },
    Revoked: ({ type, id }) => ({
      model: {
        ...model,
        connections:
          model.connections?.filter(
            (connection) => connection.type !== type || connection.id !== id,
          ) ?? null,
        pending: false,
      },
    }),
    Failed: ({ error }) => ({ model: { ...model, pending: false, error } }),
  });

const headingId = "connected-clients-heading";

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.section(
    [h.Class("connected-clients")],
    [
      h.h2([h.Id(headingId)], ["Clients"]),
      h.p(
        [h.Id("cli-access")],
        ["Run ", h.code([], ["one auth login"]), " to connect a CLI device."],
      ),
      ...(model.connections === null
        ? [h.p([h.Role("status")], ["Loading connections…"])]
        : model.connections.length > 0
          ? [
              h.div(
                [
                  h.Class("connections-table-container"),
                  h.Role("region"),
                  h.AriaLabelledBy(headingId),
                  h.Tabindex(0),
                ],
                [
                  h.table(
                    [h.Class("connections-table")],
                    [
                      h.thead(
                        [],
                        [
                          h.tr(
                            [],
                            ["Client", "Type", "Actions"].map((label) =>
                              h.th([h.Scope("col")], [label]),
                            ),
                          ),
                        ],
                      ),
                      h.tbody(
                        [],
                        model.connections.map((connection) =>
                          h.tr(
                            [h.Key(`${connection.type}:${connection.id}`)],
                            [
                              h.th([h.Scope("row")], [connection.name]),
                              h.td([], [connection.type]),
                              h.td(
                                [],
                                [
                                  h.button(
                                    [
                                      h.Type("button"),
                                      h.Disabled(model.pending),
                                      h.AriaLabel(
                                        `Revoke ${connection.name} access`,
                                      ),
                                      h.OnClick(
                                        Message.RequestedRevocation({
                                          type: connection.type,
                                          id: connection.id,
                                        }),
                                      ),
                                    ],
                                    ["Revoke"],
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ]
          : model.unavailable.length === 0
            ? [h.p([], ["No connected clients."])]
            : []),
      ...(model.unavailable.length > 0
        ? [
            h.p(
              [h.Role("alert")],
              [
                `Could not load connections for ${model.unavailable.join(", ")}.`,
              ],
            ),
            h.button(
              [
                h.Type("button"),
                h.Disabled(model.pending),
                h.OnClick(Message.Requested()),
              ],
              ["Retry loading connections"],
            ),
          ]
        : []),
      h.p([h.Role("alert")], [model.error]),
    ],
  ),
);
