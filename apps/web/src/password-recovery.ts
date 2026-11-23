import { appName } from "@oneapp/core";
import { EmailDelivery } from "@yielded/auth";
import { Effect, Option, Redacted, Schema } from "effect";
import { Command, Runtime, Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import * as Notifications from "./notifications.ts";
import { notificationView } from "./notification-view.ts";
import {
  forgotPasswordPage,
  passwordResetPath,
  resetPasswordPage,
} from "./password-recovery-contract.ts";

const Model = Schema.Struct({
  phase: Schema.Literals([
    "request",
    "requested",
    "reset",
    "reset-complete",
    "invalid",
  ]),
  pending: Schema.Boolean,
  error: Schema.String,
  notifications: Notifications.Model,
});
type Model = typeof Model.Type;

const Message = defineMessageUnion({
  Submitted: {},
  Requested: {},
  ResetComplete: {},
  Failed: { error: Schema.String },
  GotNotification: { message: Notifications.Message },
});
type Message = typeof Message.Type;

const submit = <Success extends Message>(
  path: string,
  body: object,
  success: Success,
) =>
  Effect.tryPromise(async (signal) => {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-effect-auth-csrf": "1",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (response.ok) return success;
    const { error } = Schema.decodeUnknownSync(
      Schema.Struct({ error: Schema.String }),
    )(await response.json());
    return Message.Failed({ error });
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        Message.Failed({ error: "Could not complete the request. Try again." }),
      ),
    ),
  );

export const isRecoveryPage = (pathname: string) =>
  pathname === forgotPasswordPage || pathname === resetPasswordPage;

export const run = (pathname: string) => {
  const resetting = pathname === resetPasswordPage;
  let link =
    Option.none<
      Effect.Success<ReturnType<typeof EmailDelivery.parseLinkFragment>>
    >();
  if (resetting && location.hash) {
    const fragment = Redacted.make(location.hash);
    history.replaceState(history.state, "", resetPasswordPage);
    link = Effect.runSync(
      EmailDelivery.parseLinkFragment(fragment).pipe(Effect.option),
    );
  }

  const Submit = Command.define("SubmitPasswordRecovery", {
    args: {},
    messages: [Message.Requested, Message.ResetComplete, Message.Failed],
    execute: () =>
      Effect.suspend(
        (): Effect.Effect<
          Extract<Message, { _tag: "Requested" | "ResetComplete" | "Failed" }>
        > => {
          const element = document.getElementById("password-recovery");
          if (!(element instanceof HTMLFormElement)) {
            return Effect.succeed(
              Message.Failed({ error: "Could not read the form." }),
            );
          }
          const values = new FormData(element);
          if (!resetting) {
            return submit(
              passwordResetPath,
              { email: values.get("email") },
              Message.Requested(),
            );
          }
          if (Option.isNone(link)) {
            return Effect.succeed(
              Message.Failed({ error: "Request a new reset link." }),
            );
          }
          const newPassword = values.get("new-password");
          const confirmPassword = values.get("confirm-password");
          element.reset();
          if (newPassword !== confirmPassword) {
            return Effect.succeed(
              Message.Failed({ error: "The new passwords do not match." }),
            );
          }
          return submit(
            `${passwordResetPath}/complete`,
            {
              reference: link.value.reference,
              secret: Redacted.value(link.value.secret),
              newPassword,
            },
            Message.ResetComplete(),
          ).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                if (result._tag === "ResetComplete") link = Option.none();
              }),
            ),
          );
        },
      ),
  });

  const init = (): Update.Return<Model, Message> => ({
    model: {
      phase: resetting
        ? Option.isSome(link)
          ? "reset"
          : "invalid"
        : "request",
      pending: false,
      error: "",
      notifications: Notifications.init(),
    },
  });

  const update = (model: Model, message: Message) =>
    Message.match<Update.Return<Model, Message>>(message, {
      Submitted: () =>
        model.pending
          ? { model }
          : {
              model: { ...model, pending: true, error: "" },
              commands: [Submit({})],
            },
      Requested: () => ({
        model: { ...model, phase: "requested", pending: false, error: "" },
      }),
      ResetComplete: () => ({
        model: { ...model, phase: "reset-complete", pending: false, error: "" },
      }),
      Failed: ({ error }) => ({ model: { ...model, pending: false, error } }),
      GotNotification: ({ message }) => {
        const result = Notifications.update(model.notifications, message);
        return {
          model: { ...model, notifications: result.model },
          commands: Command.mapMessages(result.commands ?? [], (message) =>
            Message.GotNotification({ message }),
          ),
        };
      },
    });

  const pageView = (model: Model, h: HtmlBuilder<Message>): Document => {
    const title = resetting ? "Reset password" : "Forgot password";
    const passwordField = (id: string, label: string) => [
      h.label([h.For(id)], [label]),
      h.input([
        h.Id(id),
        h.Name(id),
        h.Type("password"),
        h.Autocomplete("new-password"),
        h.Required(true),
      ]),
    ];
    const formAttributes = [
      h.Id("password-recovery"),
      h.Method("post"),
      h.OnSubmit(Message.Submitted()),
    ];
    const body = {
      request: () =>
        h.form(formAttributes, [
          h.label([h.For("recovery-email")], ["Email"]),
          h.input([
            h.Id("recovery-email"),
            h.Name("email"),
            h.Type("email"),
            h.Autocomplete("username"),
            h.Required(true),
          ]),
          h.button(
            [h.Type("submit"), h.Disabled(model.pending)],
            [model.pending ? "Requesting…" : "Send reset link"],
          ),
        ]),
      requested: () =>
        h.p(
          [h.Role("status")],
          [
            "If that address is verified on OneApp, check your inbox for a reset link. The link expires in five minutes.",
          ],
        ),
      reset: () =>
        h.form(formAttributes, [
          h.p(
            [],
            [
              "Use at least 15 characters. Resetting your password signs out all browsers.",
            ],
          ),
          ...passwordField("new-password", "New password"),
          ...passwordField("confirm-password", "Confirm new password"),
          h.button(
            [h.Type("submit"), h.Disabled(model.pending)],
            [model.pending ? "Resetting…" : "Reset password"],
          ),
        ]),
      "reset-complete": () =>
        h.p(
          [h.Role("status")],
          ["Password reset. Sign in with your new password."],
        ),
      invalid: () =>
        h.p(
          [h.Role("alert")],
          [
            "This reset link is invalid or missing. Reopen it from your email or request a new link.",
          ],
        ),
    }[model.phase]();
    return {
      title: `${title} · ${appName}`,
      body: h.main(
        [h.Class("standalone")],
        [
          h.h1([], [title]),
          body,
          h.p([h.Role("alert")], [model.error]),
          ...(model.phase === "invalid" || model.phase === "reset"
            ? [
                h.p(
                  [],
                  [h.a([h.Href(forgotPasswordPage)], ["Request a new link"])],
                ),
              ]
            : []),
          h.a([h.Href("/")], ["Back to sign in"]),
        ],
      ),
    };
  };

  const view = (model: Model, h: HtmlBuilder<Message>): Document => {
    const page = pageView(model, h);
    return {
      ...page,
      body: h.div(
        [],
        [
          page.body,
          notificationView(
            model.notifications,
            (message) => Message.GotNotification({ message }),
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
};
