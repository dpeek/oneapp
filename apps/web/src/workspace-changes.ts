import { Effect, Queue, Schema, Stream } from "effect";
import { filesChanged } from "./files-contract.ts";
import {
  inboxChanged,
  InboxVersion,
  inboxVersionPath,
} from "./inbox-contract.ts";
import { tagsChanged } from "./items-contract.ts";
import {
  latestTaskDeploymentPath,
  TaskDeployment,
} from "./task-run-contract.ts";
import { tasksChanged } from "./tasks-contract.ts";
import {
  workspaceEventsPath,
  type WorkspaceChange,
} from "./workspace-change-contract.ts";

const decodeDeployment = Schema.decodeUnknownSync(
  Schema.NullOr(TaskDeployment),
);

const coalescedCheck = (signal: AbortSignal, check: () => Promise<void>) => {
  let checking = false;
  let queued = false;
  const run = async () => {
    checking = true;
    do {
      queued = false;
      try {
        await check();
      } catch {
        // A later signal can recover from a failed request.
      }
    } while (queued && !signal.aborted);
    checking = false;
  };
  return () => {
    if (signal.aborted) return;
    if (checking) queued = true;
    else void run();
  };
};

type InboxChange = { inboxVersion: number | null };

export const changes = Stream.callback<
  Exclude<WorkspaceChange, typeof inboxChanged> | TaskDeployment | InboxChange
>(
  (queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const url = new URL(workspaceEventsPath, window.location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        let stopped = false;
        let socket: WebSocket | undefined;
        let retry: number | undefined;
        let delay = 1000;
        let mailVersion = -1;
        let latestDeployment: TaskDeployment | null | undefined;
        const checks = new AbortController();
        const changed = (
          change:
            | Exclude<WorkspaceChange, typeof inboxChanged>
            | TaskDeployment
            | InboxChange,
        ) => {
          if (!stopped) Queue.offerUnsafe(queue, change);
        };
        const checkMail = coalescedCheck(checks.signal, async () => {
          const result = await checkIndex(
            inboxVersionPath,
            mailVersion,
            InboxVersion,
            checks.signal,
          );
          if (result === "expired") changed({ inboxVersion: null });
          else if (result !== "unchanged") {
            mailVersion = result.version;
            changed({ inboxVersion: mailVersion });
          }
        });
        const checkDeployment = coalescedCheck(checks.signal, async () => {
          const response = await fetch(latestTaskDeploymentPath, {
            signal: checks.signal,
            cache: "no-store",
          });
          if (!response.ok) return;
          const deployment = decodeDeployment(await response.json());
          if (latestDeployment === undefined) {
            latestDeployment = deployment;
          } else if (
            deployment &&
            (!latestDeployment ||
              (deployment.id !== latestDeployment.id &&
                (deployment.finishedAt > latestDeployment.finishedAt ||
                  (deployment.finishedAt === latestDeployment.finishedAt &&
                    deployment.id > latestDeployment.id))))
          ) {
            // Removing or reclaiming a task can expose an older successful run.
            latestDeployment = deployment;
            changed(deployment);
          }
        });
        const refresh = () => {
          checkMail();
          checkDeployment();
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
            if (data === inboxChanged) checkMail();
            if (data === tasksChanged) checkDeployment();
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
          if (document.visibilityState === "visible") checkMail();
        }, 30_000);
        checkMail();
        checkDeployment();
        connect();
        return () => {
          document.removeEventListener("visibilitychange", resumed);
          window.removeEventListener("online", resumed);
          window.removeEventListener("focus", resumed);
          stopped = true;
          checks.abort();
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
