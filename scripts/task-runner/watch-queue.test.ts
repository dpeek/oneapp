import { expect, it, vi } from "@effect/vitest";
import { filesChanged } from "../../apps/web/src/files-contract.ts";
import { tagsChanged } from "../../apps/web/src/items-contract.ts";
import { tasksChanged } from "../../apps/web/src/tasks-contract.ts";
import { taskRunnerEventsPath } from "../../apps/web/src/workspace-change-contract.ts";
import { watchTaskQueue } from "./watch-queue.ts";

it("wakes for task and tag changes, coalesces active work, and checks on reconnect", async () => {
  const token = "runner-fixture";
  let peer: Bun.ServerWebSocket<undefined> | undefined;
  const upgrades = vi.fn();
  using listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (
        new URL(request.url).pathname !== taskRunnerEventsPath ||
        request.headers.get("authorization") !== `Bearer ${token}`
      )
        return new Response(null, { status: 403 });
      upgrades();
      if (!server.upgrade(request)) return new Response(null, { status: 400 });
    },
    websocket: {
      open(socket) {
        peer = socket;
      },
      message() {},
    },
  });
  const shutdown = new AbortController();
  const release = Promise.withResolvers<void>();
  const check = vi.fn(async () => false);
  const watcher = watchTaskQueue({
    origin: listener.url.origin,
    token,
    signal: shutdown.signal,
    check,
  });
  const waitForCheck = (count: number) =>
    vi.waitFor(() => expect(check).toHaveBeenCalledTimes(count), {
      timeout: 2_500,
      interval: 10,
    });
  try {
    await waitForCheck(2);
    check.mockImplementationOnce(async () => {
      await release.promise;
      return false;
    });

    peer!.send(tasksChanged);
    await waitForCheck(3);
    peer!.send(tasksChanged);
    peer!.send(tagsChanged);
    peer!.send(tasksChanged);
    await Bun.sleep(25);
    expect(check).toHaveBeenCalledTimes(3);
    release.resolve();
    await waitForCheck(4);

    peer!.send(filesChanged);
    await Bun.sleep(25);
    expect(check).toHaveBeenCalledTimes(4);
    peer!.send(tagsChanged);
    await waitForCheck(5);

    peer!.close();
    await waitForCheck(6);
    expect(upgrades).toHaveBeenCalledTimes(2);
  } finally {
    shutdown.abort();
    release.resolve();
    await watcher;
  }
});

it("checks immediately at startup and falls back when no notification arrives", async () => {
  using listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 503 }),
  });
  const shutdown = new AbortController();
  const check = vi.fn(async () => false);
  const watcher = watchTaskQueue({
    origin: listener.url.origin,
    token: "runner-fixture",
    signal: shutdown.signal,
    check,
    fallbackMs: 200,
  });
  try {
    await Promise.resolve();
    expect(check).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2));
  } finally {
    shutdown.abort();
    await watcher;
  }
});
