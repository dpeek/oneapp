import { expect, it, vi } from "@effect/vitest";
import { runInNewContext } from "node:vm";
import { mailMessagePage } from "./inbox-contract.ts";

const source = await Bun.file(
  new URL("../public/sw.js", import.meta.url),
).text();
const origin = "https://oneapp.example";
const id = "0-0000000000001-00000000-0000-4000-8000-000000000001.eml";
const href = new URL(mailMessagePage("all", id), origin).href;
const setup = () => {
  const handlers = new Map<string, (event: any) => void>();
  const notifications = vi.fn(async () => {});
  const windows: {
    url: string;
    navigate: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  }[] = [];
  const openWindow = vi.fn(async () => {});
  const fetch = vi.fn(async (_request: unknown) => new Response("online"));
  const cache = { addAll: vi.fn(async () => {}) };
  const caches = {
    open: vi.fn(async () => cache),
    keys: async () => ["oneapp-offline-old", "unrelated"],
    delete: vi.fn(async () => true),
    match: vi.fn(async () => new Response("offline")),
  };
  runInNewContext(source, {
    self: {
      addEventListener: (name: string, handler: (event: any) => void) =>
        handlers.set(name, handler),
      location: { origin },
      skipWaiting: async () => {},
      registration: { showNotification: notifications },
      clients: {
        claim: async () => {},
        matchAll: async () => windows,
        openWindow,
      },
    },
    caches,
    fetch,
    URL,
    Response,
  });
  const dispatch = async (name: string, properties: object) => {
    const work: Promise<unknown>[] = [];
    handlers.get(name)!({
      ...properties,
      waitUntil: (promise: Promise<unknown>) => work.push(promise),
      respondWith: (promise: Promise<unknown>) => work.push(promise),
    });
    return Promise.all(work);
  };
  return { dispatch, notifications, windows, openWindow, fetch, caches, cache };
};

it("shows a visible private alert for every push, including malformed payloads", async () => {
  const worker = setup();
  await worker.dispatch("push", {
    data: {
      json: () => ({
        url: href,
        tag: "stable-message",
        body: "Secret email",
        title: "Secret subject",
      }),
    },
  });
  expect(worker.notifications).toHaveBeenCalledWith(
    "New mail",
    expect.objectContaining({
      body: "Open Orumai to read your message.",
      tag: "stable-message",
      data: { url: href },
    }),
  );
  await worker.dispatch("push", {
    data: {
      json: () => {
        throw new Error("Bad JSON");
      },
    },
  });
  expect(worker.notifications).toHaveBeenCalledTimes(2);
});

it("opens the actual received-message URL on a cold launch and rejects external destinations", async () => {
  const worker = setup();
  const close = vi.fn();
  await worker.dispatch("notificationclick", {
    notification: { close, data: { url: href } },
  });
  expect(close).toHaveBeenCalled();
  expect(worker.openWindow).toHaveBeenCalledWith(href);
  await worker.dispatch("notificationclick", {
    notification: {
      close,
      data: { url: "https://attacker.example/app/mail/all/received/fake" },
    },
  });
  expect(worker.openWindow).toHaveBeenLastCalledWith(`${origin}/app/mail`);
});

it("focuses a matching window and navigates an existing window to a different message", async () => {
  const worker = setup();
  const window = {
    url: href,
    focus: vi.fn(async () => {}),
    navigate: vi.fn(async (_url: string) => window),
  };
  const approval = {
    url: `${origin}/?connect-mcp=1`,
    focus: vi.fn(async () => {}),
    navigate: vi.fn(async (_url: string) => approval),
  };
  worker.windows.push(approval);
  worker.windows.push(window);
  await worker.dispatch("notificationclick", {
    notification: { close() {}, data: { url: href } },
  });
  expect(window.focus).toHaveBeenCalledTimes(1);
  expect(window.navigate).not.toHaveBeenCalled();
  window.url = `${origin}/app/settings`;
  await worker.dispatch("notificationclick", {
    notification: { close() {}, data: { url: href } },
  });
  expect(window.navigate).toHaveBeenCalledWith(href);
  expect(window.focus).toHaveBeenCalledTimes(2);
  expect(approval.navigate).not.toHaveBeenCalled();
  expect(worker.openWindow).not.toHaveBeenCalled();
});

it("caches only the static offline page and leaves mail API requests alone", async () => {
  const worker = setup();
  await worker.dispatch("install", {});
  expect(worker.cache.addAll).toHaveBeenCalledWith(["/offline.html"]);
  await worker.dispatch("activate", {});
  expect(worker.caches.delete).toHaveBeenCalledExactlyOnceWith(
    "oneapp-offline-old",
  );
  await worker.dispatch("fetch", {
    request: { mode: "cors", method: "GET", url: `${origin}/api/inbox` },
  });
  expect(worker.fetch).not.toHaveBeenCalled();
  worker.fetch.mockRejectedValueOnce(new Error("Offline"));
  const [response] = await worker.dispatch("fetch", {
    request: { mode: "navigate", method: "GET", url: href },
  });
  expect(await (response as Response).text()).toBe("offline");
  expect(worker.caches.match).toHaveBeenCalledWith("/offline.html");
});

it("opens the calendar from a private reminder using the same-origin calendar route", async () => {
  const worker = setup();
  await worker.dispatch("push", {
    data: {
      json: () => ({
        type: "calendar",
        title: "Private event",
        tag: "calendar:event:time",
        url: "https://example.com/app/calendar",
      }),
    },
  });
  const url = `${origin}/app/calendar`;
  expect(worker.notifications).toHaveBeenCalledWith(
    "Calendar reminder",
    expect.objectContaining({
      body: "Open Orumai to see your schedule.",
      tag: "calendar:event:time",
      data: { url },
    }),
  );
  await worker.dispatch("notificationclick", {
    notification: { close() {}, data: { url } },
  });
  expect(worker.openWindow).toHaveBeenCalledWith(url);
});
