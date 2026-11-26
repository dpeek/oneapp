import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
vi.mock("@orumai/ui", () => ({}));
import { initial, Message, update } from "./push-settings.ts";
import { bindNotificationPermission } from "./push-browser.ts";

it("calls permission from the click handler and cleans up the listener", async () => {
  const permission = vi.fn(() => Promise.resolve("granted"));
  vi.stubGlobal("Notification", { requestPermission: permission });
  try {
    const element = new EventTarget();
    const events: { request: string; permission: string }[] = [];
    element.addEventListener("orumai-push-permission", (event) =>
      events.push((event as CustomEvent).detail),
    );
    const cleanup = bindNotificationPermission(element as HTMLElement);
    element.dispatchEvent(new Event("click"));
    expect(permission).toHaveBeenCalledTimes(1);
    expect(events[0]?.permission).toBe("pending");
    await Promise.resolve();
    expect(events[1]).toEqual({
      request: events[0]!.request,
      permission: "granted",
    });
    cleanup();
    element.dispatchEvent(new Event("click"));
    expect(permission).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("only subscribes after permission is granted and ignores stale completions after logout", () => {
  const model = { ...initial, status: "off" as const, publicKey: "key" };
  const started = update(
    model,
    Message.Permission({ request: "attempt", permission: "pending" }),
  );
  expect(started.commands).toBeUndefined();
  const allowed = update(
    started.model,
    Message.Permission({ request: "attempt", permission: "granted" }),
  );
  expect(allowed.commands).toHaveLength(1);
  const denied = update(
    started.model,
    Message.Permission({ request: "attempt", permission: "denied" }),
  );
  expect(denied.model.status).toBe("blocked");
  expect(denied.commands).toBeUndefined();
  expect(
    update(
      initial,
      Message.Loaded({ request: "attempt", publicKey: "key", status: "on" }),
    ).model,
  ).toEqual(initial);
  expect(
    update(
      initial,
      Message.Permission({ request: "attempt", permission: "granted" }),
    ).commands,
  ).toBeUndefined();
});
