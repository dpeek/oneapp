import {
  isTaskQueueChange,
  taskRunnerEventsPath,
} from "../../apps/web/src/workspace-change-contract.ts";

const initialRetryMs = 1_000;
const maxRetryMs = 30_000;
// The workspace's DOM types omit Bun's header options.
const BunWebSocket = WebSocket as typeof WebSocket & {
  new (url: URL, options: Bun.WebSocketOptions): WebSocket;
};

export async function watchTaskQueue({
  origin,
  token,
  signal,
  check,
  fallbackMs = 60_000,
}: {
  origin: string;
  token: string;
  signal: AbortSignal;
  check: () => Promise<boolean>;
  fallbackMs?: number;
}) {
  if (signal.aborted) return;

  const url = new URL(taskRunnerEventsPath, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = initialRetryMs;
  // One pending check covers every change received during the current attempt.
  let pending = Promise.withResolvers<void>();
  const wake = () => pending.resolve();
  const connect = () => {
    if (signal.aborted) return;
    const connection = new BunWebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    socket = connection;
    connection.onopen = () => {
      delay = initialRetryMs;
      // A fresh subscription may have missed changes while disconnected.
      wake();
    };
    connection.onmessage = ({ data }) => {
      if (isTaskQueueChange(data)) wake();
    };
    connection.onclose = () => {
      if (signal.aborted) return;
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, maxRetryMs);
    };
  };

  signal.addEventListener("abort", wake, { once: true });
  const fallback = setInterval(wake, fallbackMs);
  try {
    connect();
    wake();
    while (!signal.aborted) {
      await pending.promise;
      if (signal.aborted) break;
      pending = Promise.withResolvers<void>();
      if (await check()) wake();
    }
  } finally {
    signal.removeEventListener("abort", wake);
    clearInterval(fallback);
    clearTimeout(retry);
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
  }
}
