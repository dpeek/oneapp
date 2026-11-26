import {
  CliRequestedScopes,
  CliLoginApproval,
  CliLoginId,
  cliLinkScopes,
  cliLoginQuery,
  cliLoginPath,
} from "@orumai/core/cli-auth";
import { Effect, Schema } from "effect";
import { Command, Submodel, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";

export const Model = Schema.Struct({
  id: CliLoginId,
  approval: Schema.NullOr(CliLoginApproval),
  decision: Schema.NullOr(Schema.Boolean),
  pending: Schema.Boolean,
  error: Schema.String,
});
type Model = typeof Model.Type;

export function initial(): Model | null {
  const id = new URL(window.location.href).searchParams.get(cliLoginQuery);
  return Schema.is(CliLoginId)(id)
    ? { id, approval: null, decision: null, pending: false, error: "" }
    : null;
}

export const Message = defineMessageUnion({
  Requested: {},
  Decided: { approve: Schema.Boolean },
  Loaded: { approval: CliLoginApproval },
  Finished: { approved: Schema.Boolean },
  Failed: { error: Schema.String },
});
type Message = typeof Message.Type;

const failure = (error: string) => Effect.succeed(Message.Failed({ error }));
const unavailable =
  "This CLI login request is no longer available. Run one auth login again.";

const Load = Command.define("LoadCliLogin", {
  args: { id: CliLoginId },
  messages: [Message.Loaded, Message.Failed],
  execute: ({ id }) =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(`${cliLoginPath}/${id}`, {
        cache: "no-store",
        signal,
      });
      if (response.status === 410)
        return Message.Failed({ error: unavailable });
      if (!response.ok) throw new Error("Could not load CLI login");
      return Message.Loaded({
        approval: Schema.decodeUnknownSync(CliLoginApproval)(
          await response.json(),
        ),
      });
    }).pipe(
      Effect.catch(() =>
        failure("Could not load the CLI login request. Try again."),
      ),
    ),
});

const Decide = Command.define("DecideCliLogin", {
  args: { id: CliLoginId, approve: Schema.Boolean, scopes: CliRequestedScopes },
  messages: [Message.Finished, Message.Failed],
  execute: ({ id, approve, scopes }) =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(`${cliLoginPath}/${id}`, {
        method: "POST",
        headers: {
          "x-effect-auth-csrf": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify(approve ? { approve, scopes } : { approve }),
        signal,
      });
      if (response.status === 410)
        return Message.Failed({ error: unavailable });
      if (response.status === 401)
        return Message.Failed({
          error: "Your session expired. Reload the page to sign in.",
        });
      if (response.status !== 204)
        throw new Error("Could not respond to CLI login");
      const url = new URL(window.location.href);
      if (url.searchParams.get(cliLoginQuery) === id) {
        url.searchParams.delete(cliLoginQuery);
        window.history.replaceState(null, "", url);
      }
      return Message.Finished({ approved: approve });
    }).pipe(
      Effect.catch(() =>
        failure(
          "Could not confirm your response. Check your terminal before retrying.",
        ),
      ),
    ),
});

export const update = (model: Model, message: Message) => {
  const pending = { ...model, pending: true, error: "" };
  return Message.match<Update.Return<Model, Message>>(message, {
    Requested: () =>
      model.pending
        ? { model }
        : { model: pending, commands: [Load({ id: model.id })] },
    Decided: ({ approve }) =>
      model.pending || !model.approval || model.decision !== null
        ? { model }
        : {
            model: pending,
            commands: [
              Decide({
                id: model.id,
                approve,
                scopes: model.approval.scopes ?? cliLinkScopes,
              }),
            ],
          },
    Loaded: ({ approval }) => ({
      model: { ...model, approval, pending: false },
    }),
    Finished: ({ approved }) => ({
      model: { ...model, decision: approved, pending: false },
    }),
    Failed: ({ error }) => ({ model: { ...model, pending: false, error } }),
  });
};

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.section(
    [h.Class("cli-approval")],
    [
      h.h2([], ["Connect the Orumai CLI"]),
      ...(model.decision !== null
        ? [
            h.p(
              [h.Role("status")],
              [
                model.decision
                  ? "Approved. Return to your terminal to finish."
                  : "CLI login declined.",
              ],
            ),
            h.a([h.Href("/")], ["Back to Orumai"]),
          ]
        : model.approval
          ? [
              h.p(
                [],
                [
                  model.approval.scopes?.some(
                    (scope) => scope === "mail:import",
                  )
                    ? `Allow ${model.approval.label} to import mail into your mailboxes and mark eligible imported conversations complete for 24 hours. This also allows reading import receipts.`
                    : `Allow ${model.approval.label} to read, save, and delete links until you revoke access.`,
                ],
              ),
              h.p(
                [],
                [
                  "Connect only if you started this login and the code matches your terminal.",
                ],
              ),
              h.code([], [model.approval.code]),
              h.div(
                [h.Class("cli-approval-actions")],
                [
                  h.button(
                    [
                      h.Type("button"),
                      h.Disabled(model.pending),
                      h.OnClick(Message.Decided({ approve: true })),
                    ],
                    ["Connect CLI"],
                  ),
                  h.button(
                    [
                      h.Type("button"),
                      h.Disabled(model.pending),
                      h.OnClick(Message.Decided({ approve: false })),
                    ],
                    ["Decline"],
                  ),
                ],
              ),
            ]
          : model.pending
            ? [h.p([h.Role("status")], ["Loading approval request…"])]
            : [
                h.button(
                  [h.Type("button"), h.OnClick(Message.Requested())],
                  ["Retry"],
                ),
              ]),
      h.p([h.Role("alert")], [model.error]),
    ],
  ),
);
