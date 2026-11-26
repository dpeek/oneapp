import { Effect, Queue, Schema, Stream } from "effect";
import { filesChanged } from "./files-contract.ts";
import {
  inboxChanged,
  inboxEventsPath,
  InboxVersion,
  inboxVersionPath,
} from "./inbox-contract.ts";
import { tagsChanged } from "./items-contract.ts";
import { tasksChanged } from "./tasks-contract.ts";
import type { WorkspaceChange } from "./workspace-change-contract.ts";

export const changes = Stream.callback<WorkspaceChange>(
  (queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const url = new URL(inboxEventsPath, window.location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        let stopped = false;
        let socket: WebSocket | undefined;
        let retry: number | undefined;
        let delay = 1000;
        let mailVersion = -1;
        let checkingMail = false;
        let mailCheckQueued = false;
        const mailChecks = new AbortController();
        const changed = (change: WorkspaceChange) => {
          if (!stopped) Queue.offerUnsafe(queue, change);
        };
        const checkMail = async () => {
          if (stopped) return;
          if (checkingMail) {
            mailCheckQueued = true;
            return;
          }
          checkingMail = true;
          try {
            const result = await checkIndex(
              inboxVersionPath,
              mailVersion,
              InboxVersion,
              mailChecks.signal,
            );
            if (result === "expired") changed(inboxChanged);
            else if (result !== "unchanged") {
              mailVersion = result.version;
              changed(inboxChanged);
            }
          } catch {
            // The next check can recover from a failed request.
          } finally {
            checkingMail = false;
            if (mailCheckQueued) {
              mailCheckQueued = false;
              void checkMail();
            }
          }
        };
        const refresh = () => {
          void checkMail();
          changed(tagsChanged);
        };
        const connect = () => {
          const connection = new WebSocket(url);
          socket = connection;
          connection.onopen = () => {
            delay = 1000;
            refresh();
          };
          connection.onmessage = ({ data }) => {
            if (data === inboxChanged) void checkMail();
            if (
              data === tasksChanged ||
              data === filesChanged ||
              data === tagsChanged
            )
              changed(data);
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
        document.addEventListener("visibilitychange", resumed);
        window.addEventListener("online", resumed);
        window.addEventListener("focus", resumed);
        const poll = window.setInterval(() => {
          if (document.visibilityState === "visible") void checkMail();
        }, 30_000);
        void checkMail();
        connect();
        return () => {
          document.removeEventListener("visibilitychange", resumed);
          window.removeEventListener("online", resumed);
          window.removeEventListener("focus", resumed);
          stopped = true;
          mailChecks.abort();
          window.clearInterval(poll);
          window.clearTimeout(retry);
          socket?.close();
        };
      }),
      (stop) => Effect.sync(stop),
    ).pipe(Effect.andThen(Effect.never)),
  { bufferSize: 16, strategy: "sliding" },
);

export const checkIndex = async <A>(
  path: string,
  version: number,
  schema: Schema.Decoder<A>,
  signal: AbortSignal,
) => {
  const response = await fetch(`${path}?since=${version}`, {
    signal,
    cache: "no-store",
  });
  if (response.status === 401) return "expired";
  if (response.status === 204 || !response.ok) return "unchanged";
  return Schema.decodeUnknownSync(schema)(await response.json());
};
