import { Effect, Queue, Stream } from "effect";
import { inboxChanged, inboxEventsPath } from "./inbox-contract.ts";
import { tasksChanged } from "./tasks-contract.ts";

export const changes = Stream.callback<"inbox" | "tasks">(
  (queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const url = new URL(inboxEventsPath, window.location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        let stopped = false;
        let socket: WebSocket | undefined;
        let retry: number | undefined;
        let delay = 1000;
        const changed = (area: "inbox" | "tasks") => {
          if (!stopped) Queue.offerUnsafe(queue, area);
        };
        const refresh = () => {
          changed("inbox");
          changed("tasks");
        };
        const connect = () => {
          const connection = new WebSocket(url);
          socket = connection;
          connection.onopen = () => {
            delay = 1000;
            refresh();
          };
          connection.onmessage = (event) => {
            if (event.data === inboxChanged) changed("inbox");
            if (event.data === tasksChanged) changed("tasks");
          };
          connection.onclose = (event) => {
            if (stopped) return;
            if (event.code === 1008) refresh();
            retry = window.setTimeout(connect, delay);
            delay = Math.min(delay * 2, 30_000);
          };
        };
        const resumed = () => {
          if (document.visibilityState !== "hidden") refresh();
        };
        const focused = () => changed("tasks");
        document.addEventListener("visibilitychange", resumed);
        window.addEventListener("online", resumed);
        window.addEventListener("focus", focused);
        connect();
        return () => {
          document.removeEventListener("visibilitychange", resumed);
          window.removeEventListener("online", resumed);
          window.removeEventListener("focus", focused);
          stopped = true;
          window.clearTimeout(retry);
          socket?.close();
        };
      }),
      (stop) => Effect.sync(stop),
    ).pipe(Effect.andThen(Effect.never)),
  { bufferSize: 16, strategy: "sliding" },
);
