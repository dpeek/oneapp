import { Schema } from "effect";

export const pushPath = "/api/push";
// A subscription is an outbound request destination. Only browser push services
// are accepted; redirects are also disabled when delivering notifications.
export const isPushEndpoint = (value: string) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      (url.hostname === "web.push.apple.com" ||
        url.hostname.endsWith(".push.apple.com") ||
        url.hostname === "fcm.googleapis.com" ||
        url.hostname === "updates.push.services.mozilla.com" ||
        url.hostname.endsWith(".notify.windows.com"))
    );
  } catch {
    return false;
  }
};
export const PushEndpoint = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter(isPushEndpoint),
);
export const PushSubscriptionInput = Schema.Struct({
  endpoint: PushEndpoint,
  keys: Schema.Struct({
    p256dh: Schema.String.check(Schema.isPattern(/^B[A-Za-z0-9_-]{86}$/u)),
    auth: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/u)),
  }),
});
export const PushEndpointInput = Schema.Struct({ endpoint: PushEndpoint });
export const PushConfiguration = Schema.Struct({
  publicKey: Schema.NullOr(Schema.String),
});
export const PushStatus = Schema.Struct({ enabled: Schema.Boolean });
