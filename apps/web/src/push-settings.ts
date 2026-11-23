import { button, item, itemGroup } from "@oneapp/ui";
import { Effect, Option, Schema } from "effect";
import { Command, Mount, type Update } from "foldkit";
import { type HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import {
  bindNotificationPermission,
  disableNotifications,
  enableNotifications,
  notificationState,
} from "./push-browser.ts";

const Status = Schema.Literals([
  "checking",
  "unsupported",
  "install",
  "unconfigured",
  "blocked",
  "on",
  "off",
]);
const PermissionEvent = Schema.Struct({
  request: Schema.String,
  permission: Schema.Literals([
    "pending",
    "granted",
    "denied",
    "default",
    "error",
  ]),
});
export const Model = Schema.Struct({
  status: Status,
  publicKey: Schema.NullOr(Schema.String),
  request: Schema.NullOr(Schema.String),
  error: Schema.String,
});
export type Model = typeof Model.Type;
export const initial: Model = {
  status: "checking",
  publicKey: null,
  request: null,
  error: "",
};
export const Message = defineMessageUnion({
  Requested: {},
  Mounted: {},
  Permission: PermissionEvent.fields,
  Disable: {},
  Loaded: {
    request: Schema.String,
    status: Status,
    publicKey: Schema.NullOr(Schema.String),
  },
  Failed: { request: Schema.String, error: Schema.String },
});
type Message = typeof Message.Type;
const failure = (request: string) =>
  Effect.catch(() =>
    Effect.succeed(
      Message.Failed({
        request,
        error:
          "Could not update notifications. Check your connection and try again.",
      }),
    ),
  );
const Load = Command.define("LoadPushSettings", {
  args: { request: Schema.String },
  messages: [Message.Loaded, Message.Failed],
  execute: ({ request }) =>
    Effect.tryPromise(notificationState).pipe(
      Effect.map((state) => Message.Loaded({ request, ...state })),
      failure(request),
    ),
});
const Change = Command.define("ChangePushSettings", {
  args: { request: Schema.String, publicKey: Schema.NullOr(Schema.String) },
  messages: [Message.Loaded, Message.Failed],
  execute: ({ request, publicKey }) =>
    Effect.tryPromise(async () => {
      if (publicKey) await enableNotifications(publicKey);
      else await disableNotifications();
      return Message.Loaded({ request, ...(await notificationState()) });
    }).pipe(failure(request)),
});
const BindPermission = Mount.define("BindPushPermission", {
  messages: [Message.Mounted],
  execute: ({ element }) =>
    Effect.gen(function* () {
      if (element instanceof HTMLElement)
        yield* Effect.acquireRelease(
          Effect.sync(() => bindNotificationPermission(element)),
          (cleanup) => Effect.sync(cleanup),
        );
      return Message.Mounted();
    }),
});

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    Mounted: () => ({ model }),
    Requested: () => {
      if (model.request) return { model };
      const request = crypto.randomUUID();
      return {
        model: { ...model, request, error: "" },
        commands: [Load({ request })],
      };
    },
    Permission: ({ request, permission }) => {
      if (permission === "pending")
        return model.request
          ? { model }
          : { model: { ...model, request, error: "" } };
      if (model.request !== request) return { model };
      if (permission === "granted" && model.publicKey)
        return {
          model,
          commands: [Change({ request, publicKey: model.publicKey })],
        };
      return {
        model: {
          ...model,
          request: null,
          status: permission === "denied" ? "blocked" : "off",
          error:
            permission === "error"
              ? "Could not request permission. Try again."
              : "",
        },
      };
    },
    Disable: () => {
      if (model.request) return { model };
      const request = crypto.randomUUID();
      return {
        model: { ...model, request, error: "" },
        commands: [Change({ request, publicKey: null })],
      };
    },
    Loaded: ({ request, status, publicKey }) =>
      model.request === request
        ? { model: { status, publicKey, request: null, error: "" } }
        : { model },
    Failed: ({ request, error }) =>
      model.request === request
        ? { model: { ...model, request: null, error } }
        : { model },
  });

export const view = <Parent>(
  model: Model,
  emit: (message: Message) => Parent,
  h: HtmlBuilder<Parent>,
) => {
  const descriptions = {
    checking: "Checking notifications on this device…",
    unsupported: "This browser does not support push notifications.",
    install:
      "On iPhone or iPad, use Share → Add to Home Screen, then open OneApp from its icon to enable notifications.",
    unconfigured: "Notifications are not available on this deployment yet.",
    blocked:
      "Notifications are blocked. Allow them in your device or browser notification settings, then check again.",
    on: "New mail alerts are enabled on this device. Message contents stay private. Signing out or an expired session stops alerts.",
    off: "Get a notification when new mail arrives, even when OneApp is closed. Message contents stay private.",
  };
  return h.section(
    [h.Class("settings-section"), h.AriaLabelledBy("settings-notifications")],
    [
      h.h2([h.Id("settings-notifications")], ["Notifications"]),
      itemGroup(
        [
          item(
            {
              key: "mail-push",
              title: "New mail",
              description: h.p(
                [h.Role("status")],
                [descriptions[model.status]],
              ),
              action:
                model.status === "off"
                  ? button(
                      {
                        size: "sm",
                        variant: "outline",
                        disabled: model.request !== null,
                        attributes: [
                          h.OnMount(Mount.mapMessage(BindPermission(), emit)),
                          {
                            _tag: "OnCustomEvent",
                            name: "oneapp-push-permission",
                            f: (event: CustomEvent<unknown>) =>
                              Option.map(
                                Schema.decodeUnknownOption(PermissionEvent)(
                                  event.detail,
                                ),
                                (value) => emit(Message.Permission(value)),
                              ),
                          },
                        ],
                        children: [
                          model.request ? "Enabling…" : "Enable notifications",
                        ],
                      },
                      h,
                    )
                  : model.status === "on"
                    ? button(
                        {
                          size: "sm",
                          variant: "outline",
                          disabled: model.request !== null,
                          onClick: emit(Message.Disable()),
                          children: [
                            model.request
                              ? "Disabling…"
                              : "Disable notifications",
                          ],
                        },
                        h,
                      )
                    : undefined,
            },
            h,
          ),
        ],
        h,
      ),
      ...(model.error ? [h.p([h.Role("alert")], [model.error])] : []),
      button(
        {
          size: "sm",
          variant: "ghost",
          disabled: model.request !== null,
          onClick: emit(Message.Requested()),
          children: ["Check status"],
        },
        h,
      ),
    ],
  );
};
