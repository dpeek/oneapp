import { Schema } from "effect";
import { pushPath, PushConfiguration, PushStatus } from "./push-contract.ts";

export const browserPushSupport = () => {
  if (!window.isSecureContext || !("serviceWorker" in navigator))
    return "unsupported";
  const appleMobile =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (
    appleMobile &&
    !matchMedia("(display-mode: standalone)").matches &&
    !(navigator as Navigator & { standalone?: boolean }).standalone
  )
    return "install";
  return "PushManager" in window && "Notification" in window
    ? "supported"
    : "unsupported";
};

let registration: Promise<ServiceWorkerRegistration> | undefined;
export const registerServiceWorker = () =>
  (registration ??= (async () => {
    await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Service worker unavailable")),
            15_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  })().catch((error) => {
    registration = undefined;
    throw error;
  }));

export const pushRequest = async (
  path: string,
  method = "GET",
  body?: object,
) => {
  const response = await fetch(`${pushPath}${path}`, {
    method,
    cache: "no-store",
    headers: { "content-type": "application/json", "x-effect-auth-csrf": "1" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401)
    throw new Error("Sign in again to manage notifications.");
  if (!response.ok)
    throw new Error("Could not update notifications. Try again.");
  return response;
};

export const notificationState = async () => {
  const support = browserPushSupport();
  if (support !== "supported")
    return { status: support, publicKey: null } as const;
  const config = Schema.decodeUnknownSync(PushConfiguration)(
    await (await pushRequest("")).json(),
  );
  if (!config.publicKey)
    return { status: "unconfigured", publicKey: null } as const;
  const worker = await registerServiceWorker();
  if (Notification.permission === "denied")
    return { status: "blocked", publicKey: config.publicKey } as const;
  const subscription = await worker.pushManager.getSubscription();
  const enabled =
    subscription &&
    Schema.decodeUnknownSync(PushStatus)(
      await (
        await pushRequest("/status", "POST", {
          endpoint: subscription.endpoint,
        })
      ).json(),
    ).enabled;
  return {
    status: enabled && Notification.permission === "granted" ? "on" : "off",
    publicKey: config.publicKey,
  } as const;
};

export const enableNotifications = async (publicKey: string) => {
  const worker = await registerServiceWorker();
  const key = Uint8Array.from(
    atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")),
    (character) => character.charCodeAt(0),
  );
  let subscription = await worker.pushManager.getSubscription();
  const existingKey = subscription?.options.applicationServerKey;
  if (
    subscription &&
    existingKey &&
    !new Uint8Array(existingKey).every((byte, index) => key[index] === byte)
  ) {
    await pushRequest("/subscription", "DELETE", {
      endpoint: subscription.endpoint,
    });
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await worker.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  await pushRequest("/subscription", "POST", subscription.toJSON());
};

export const disableNotifications = async () => {
  const worker = await navigator.serviceWorker.getRegistration("/");
  const subscription = await worker?.pushManager.getSubscription();
  if (subscription) {
    await pushRequest("/subscription", "DELETE", {
      endpoint: subscription.endpoint,
    });
    await subscription.unsubscribe();
  }
  const notifications = await worker?.getNotifications();
  notifications?.forEach((notification) => notification.close());
};

export const clearPushAfterSignOut = async () => {
  if (!("serviceWorker" in navigator)) return;
  const worker = await navigator.serviceWorker.getRegistration("/");
  const subscription = await worker?.pushManager?.getSubscription();
  await subscription?.unsubscribe();
  (await worker?.getNotifications())?.forEach((notification) =>
    notification.close(),
  );
};

// Run permission prompting directly in the browser click handler. Scheduling it
// as an Effect command can lose the user activation required by mobile Safari.
export const bindNotificationPermission = (element: HTMLElement) => {
  const listener = () => {
    const request = crypto.randomUUID();
    const emit = (detail: object) =>
      element.dispatchEvent(
        new CustomEvent("orumai-push-permission", { detail }),
      );
    let permission: Promise<NotificationPermission>;
    try {
      permission = Notification.requestPermission();
    } catch {
      emit({ request, permission: "pending" });
      emit({ request, permission: "error" });
      return;
    }
    emit({ request, permission: "pending" });
    void permission.then(
      (permission) => emit({ request, permission }),
      () => emit({ request, permission: "error" }),
    );
  };
  element.addEventListener("click", listener);
  return () => element.removeEventListener("click", listener);
};
