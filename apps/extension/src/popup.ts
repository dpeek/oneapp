import { appName, defaultServerUrl } from "@oneapp/core";
import { currentExtensionPath } from "@oneapp/core/extension-auth";
import { linksPath, SaveLink } from "@oneapp/core/links";
import { alert, button } from "@oneapp/ui";
import { Effect, Schema } from "effect";
import { Command, Runtime, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import {
  clearConnection,
  connect,
  connectionStatus,
  readConnection,
  serverRequest,
} from "./access.ts";

const Status = Schema.Literals(["disconnected", "pending", "connected"]);
const Model = Schema.Struct({
  status: Schema.NullOr(Status),
  busy: Schema.Boolean,
  notice: Schema.String,
  error: Schema.String,
});
type Model = typeof Model.Type;

const Message = defineMessageUnion({
  Checked: { status: Status },
  ClickedConnect: {},
  ClickedCheck: {},
  ClickedSave: {},
  ClickedDisconnect: {},
  OpenedApproval: {},
  Saved: {},
  Disconnected: {},
  LostAccess: {},
  Failed: { error: Schema.String },
});
type Message = typeof Message.Type;

const failed = (error: string) => () =>
  Effect.succeed(Message.Failed({ error }));
const validLink = Schema.is(SaveLink);

const Check = Command.define("CheckExtensionAccess", {
  args: {},
  messages: [Message.Checked, Message.Failed],
  execute: () =>
    Effect.tryPromise(async (signal) =>
      Message.Checked({ status: await connectionStatus(signal) }),
    ).pipe(Effect.catch(failed("Could not check the connection. Try again."))),
});

const Connect = Command.define("OpenExtensionApproval", {
  args: {},
  messages: [Message.OpenedApproval, Message.Failed],
  execute: () =>
    Effect.tryPromise(async () => {
      await connect();
      return Message.OpenedApproval();
    }).pipe(Effect.catch(failed("Could not open OneApp. Try again."))),
});

const Save = Command.define("SaveCurrentTab", {
  args: {},
  messages: [Message.Saved, Message.LostAccess, Message.Failed],
  execute: () =>
    Effect.tryPromise(async (signal) => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const input = { url: tab?.url };
      if (!validLink(input))
        return Message.Failed({
          error: "Open an HTTP or HTTPS page to save it.",
        });

      const connection = await readConnection();
      if (!connection) return Message.LostAccess();
      const response = await serverRequest(
        linksPath,
        connection.secret,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        signal,
      );
      if (response.status === 401) {
        await clearConnection();
        return Message.LostAccess();
      }
      if (response.status !== 201) throw new Error("Save failed");
      return Message.Saved();
    }).pipe(
      Effect.catch(
        failed(
          "Could not confirm the save. Check your OneApp links before trying again.",
        ),
      ),
    ),
});

const Disconnect = Command.define("DisconnectExtension", {
  args: {},
  messages: [Message.Disconnected, Message.Failed],
  execute: () =>
    Effect.tryPromise(async (signal) => {
      const connection = await readConnection();
      if (connection) {
        const response = await serverRequest(
          currentExtensionPath,
          connection.secret,
          { method: "DELETE" },
          signal,
        );
        if (response.status !== 204 && response.status !== 401)
          throw new Error("Disconnect failed");
      }
      await clearConnection();
      return Message.Disconnected();
    }).pipe(Effect.catch(failed("Could not disconnect. Try again."))),
});

const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: { status: null, busy: true, notice: "", error: "" },
  commands: [Check({})],
});

const update = (model: Model, message: Message) => {
  const working = { ...model, busy: true, notice: "", error: "" };
  return Message.match<Update.Return<Model, Message>>(message, {
    Checked: ({ status }) => ({ model: { ...model, status, busy: false } }),
    ClickedConnect: () => ({ model: working, commands: [Connect({})] }),
    ClickedCheck: () => ({ model: working, commands: [Check({})] }),
    ClickedSave: () => ({ model: working, commands: [Save({})] }),
    ClickedDisconnect: () => ({ model: working, commands: [Disconnect({})] }),
    OpenedApproval: () => ({
      model: { ...model, status: "pending", busy: false },
    }),
    Saved: () => ({ model: { ...model, busy: false, notice: "Tab saved." } }),
    Disconnected: () => ({
      model: {
        ...model,
        status: "disconnected",
        busy: false,
        notice: "Disconnected.",
      },
    }),
    LostAccess: () => ({
      model: {
        ...model,
        status: "disconnected",
        busy: false,
        error: "Access expired or was revoked. Connect again.",
      },
    }),
    Failed: ({ error }) => ({ model: { ...model, busy: false, error } }),
  });
};

const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const action = (label: string, onClick: Message, secondary = false) =>
    button(
      {
        variant: secondary ? "outline" : "primary",
        ...(secondary ? { size: "sm" } : {}),
        disabled: model.busy,
        focusableWhenDisabled: true,
        onClick,
        children: [label],
      },
      h,
    );

  return {
    title: appName,
    body: h.main(
      [],
      [
        h.h1([], [appName]),
        ...(model.status === "connected"
          ? [
              action("Save this tab", Message.ClickedSave()),
              h.div(
                [h.Class("actions")],
                [
                  h.a(
                    [
                      h.Href(defaultServerUrl),
                      h.Target("_blank"),
                      h.Rel("noopener noreferrer"),
                    ],
                    ["Open OneApp"],
                  ),
                  action("Disconnect", Message.ClickedDisconnect(), true),
                ],
              ),
            ]
          : model.status === "disconnected"
            ? [action("Connect to OneApp", Message.ClickedConnect())]
            : model.status === "pending"
              ? [
                  h.p([], ["Approve the connection in the OneApp tab."]),
                  action("Check connection", Message.ClickedCheck()),
                ]
              : model.busy
                ? [h.p([h.Role("status")], ["Checking connection…"])]
                : [action("Retry", Message.ClickedCheck())]),
        alert(
          {
            message: model.notice || null,
            severity: "success",
            announcement: "status",
          },
          h,
        ),
        alert(
          {
            message: model.error || null,
            severity: "error",
            announcement: "alert",
          },
          h,
        ),
      ],
    ),
  };
};

Runtime.run(
  Runtime.makeApplication({
    Model,
    init,
    update,
    view,
    container: document.getElementById("root"),
  }),
);
