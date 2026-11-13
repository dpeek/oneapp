import { Effect, Schema } from "effect";
import { Command, Submodel, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import {
  McpGrantId,
  McpGrantList,
  mcpGrantsPath,
} from "./mcp-access-contract.ts";

export const Model = Schema.Struct({
  grants: Schema.NullOr(McpGrantList),
  pending: Schema.Boolean,
  error: Schema.String,
});
type Model = typeof Model.Type;

export const initial: Model = { grants: null, pending: false, error: "" };
export const Message = defineMessageUnion({
  Requested: {},
  Loaded: { grants: McpGrantList },
  RequestedRevocation: { id: McpGrantId },
  Revoked: { id: McpGrantId },
  Failed: { error: Schema.String },
});
type Message = typeof Message.Type;

const failed = (error: string) => () =>
  Effect.succeed(Message.Failed({ error }));

const Load = Command.define("LoadMcpGrants", {
  args: {},
  messages: [Message.Loaded, Message.Failed],
  execute: () =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(mcpGrantsPath, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error("Could not load MCP access");
      return Message.Loaded({
        grants: Schema.decodeUnknownSync(McpGrantList)(await response.json()),
      });
    }).pipe(Effect.catch(failed("Could not load MCP access. Try again."))),
});

const Revoke = Command.define("RevokeMcpGrant", {
  args: { id: McpGrantId },
  messages: [Message.Revoked, Message.Failed],
  execute: ({ id }) =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(`${mcpGrantsPath}/${id}`, {
        method: "DELETE",
        headers: { "x-effect-auth-csrf": "1" },
        signal,
      });
      if (response.status !== 204)
        throw new Error("Could not revoke MCP access");
      return Message.Revoked({ id });
    }).pipe(Effect.catch(failed("Could not revoke MCP access. Try again."))),
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
    Loaded: ({ grants }) => ({ model: { grants, pending: false, error: "" } }),
    RequestedRevocation: ({ id }) =>
      model.pending
        ? { model }
        : {
            model: { ...model, pending: true, error: "" },
            commands: [Revoke({ id })],
          },
    Revoked: ({ id }) => ({
      model: {
        ...model,
        grants: model.grants?.filter((grant) => grant.id !== id) ?? null,
        pending: false,
      },
    }),
    Failed: ({ error }) => ({ model: { ...model, pending: false, error } }),
  });

const date = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.section(
    [h.Id("mcp-access")],
    [
      h.h2([], ["MCP access"]),
      model.grants === null
        ? h.button(
            [
              h.Type("button"),
              h.Disabled(model.pending),
              h.OnClick(Message.Requested()),
            ],
            ["Manage MCP access"],
          )
        : model.grants.length === 0
          ? h.p([], ["No connected MCP clients."])
          : h.ul(
              [h.Class("cli-tokens")],
              model.grants.map((grant) =>
                h.li(
                  [h.Key(grant.id)],
                  [
                    h.div(
                      [],
                      [
                        h.strong(
                          [],
                          [
                            grant.clientId === "oneapp-codex"
                              ? "Codex"
                              : grant.clientId,
                          ],
                        ),
                        h.div([], [`Expires ${date.format(grant.expiresAt)}`]),
                      ],
                    ),
                    h.button(
                      [
                        h.Type("button"),
                        h.Disabled(model.pending),
                        h.OnClick(
                          Message.RequestedRevocation({ id: grant.id }),
                        ),
                      ],
                      ["Revoke MCP access"],
                    ),
                  ],
                ),
              ),
            ),
      h.p([h.Role("alert")], [model.error]),
    ],
  ),
);
