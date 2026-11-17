import { EmailDelivery } from "@yielded/auth";
import { Effect, Redacted } from "effect";

type Sender = {
  send(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<unknown>;
};

export const disabledEmail: EmailDelivery.EmailDelivery["Service"] = {
  send: () => Effect.fail(EmailDelivery.EmailNotAccepted.make({})),
};

export const cloudflareEmail = (
  sender: Sender,
  from: string,
): EmailDelivery.EmailDelivery["Service"] => ({
  send: (message) =>
    Effect.tryPromise({
      try: () =>
        sender.send({
          from,
          to: message.to,
          subject: message.subject,
          text: Redacted.value(message.text),
        }),
      catch: () => EmailDelivery.EmailAcceptanceUnknown.make({}),
    }).pipe(
      Effect.asVoid,
      Effect.timeoutOrElse({
        duration: "8 seconds",
        orElse: () => EmailDelivery.EmailAcceptanceUnknown.make({}),
      }),
      Effect.withTracerEnabled(false),
    ),
});
