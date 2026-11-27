const offlineCache = "oneapp-offline-v1";
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(offlineCache)
      .then((cache) => cache.addAll(["/offline.html"]))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith("oneapp-offline-") && key !== offlineCache)
          await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  if (
    event.request.mode !== "navigate" ||
    event.request.method !== "GET" ||
    new URL(event.request.url).origin !== self.location.origin
  )
    return;
  // Never store the app, mail, attachments or authenticated API responses.
  event.respondWith(
    fetch(event.request).catch(
      async () =>
        (await caches.match("/offline.html")) ??
        new Response("You’re offline. Connect and reload to open Orumai.", {
          status: 503,
          headers: { "content-type": "text/plain" },
        }),
    ),
  );
});
const destination = (value) => {
  try {
    const url = new URL(value, self.location.origin);
    if (
      url.origin === self.location.origin &&
      (url.pathname === "/app/calendar" ||
        /^\/app\/mail\/all\/received\/[^/]+$/.test(url.pathname)) &&
      !url.search &&
      !url.hash
    )
      return url.href;
  } catch {}
  return new URL("/app/mail", self.location.origin).href;
};
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {}
  const calendar = payload?.type === "calendar";
  event.waitUntil(
    self.registration.showNotification(
      calendar ? "Calendar reminder" : "New mail",
      {
        body: calendar
          ? "Open Orumai to see your schedule."
          : "Open Orumai to read your message.",
        icon: "/app-icon-192.png",
        tag:
          typeof payload?.tag === "string"
            ? payload.tag.slice(0, 200)
            : calendar
              ? "oneapp-calendar"
              : "oneapp-new-mail",
        data: { url: destination(calendar ? "/app/calendar" : payload?.url) },
      },
    ),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = destination(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing =
        windows.find((client) => client.url === url) ??
        windows.find((client) => {
          const page = new URL(client.url);
          return (
            page.origin === self.location.origin &&
            (page.pathname === "/app" || page.pathname.startsWith("/app/"))
          );
        });
      if (existing) {
        try {
          const client =
            existing.url === url ? existing : await existing.navigate(url);
          if (client) {
            await client.focus();
            return;
          }
        } catch {}
      }
      await self.clients.openWindow(url);
    })(),
  );
});
