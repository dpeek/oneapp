import { open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { stopProcessGroup } from "./processes.ts";

type DevSession = {
  readonly url: string;
  readonly credentials: string;
};

export async function withDevServer<T>(
  options: {
    repo: string;
    logPath: string;
    commandPrefix: readonly string[];
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  },
  use: (dev: DevSession) => Promise<T>,
) {
  const { repo, logPath, commandPrefix, env, signal } = options;
  signal.throwIfAborted();
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 503 }),
  });
  const port = reservation.port;
  await reservation.stop(true);
  if (port === undefined)
    throw new Error("Could not reserve a local dev port.");

  const stage = "runner";
  const url = `http://localhost:${port}`;
  const state = join(repo, ".alchemy");
  const log = await open(logPath, "w", 0o600);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    try {
      signal.throwIfAborted();
      child = Bun.spawn(
        [
          ...commandPrefix,
          process.execPath,
          "--no-env-file",
          "run",
          "dev",
          "--stage",
          stage,
          "--port",
          String(port),
        ],
        {
          cwd: repo,
          env: {
            ...env,
            ALCHEMY_HOME: join(state, "runner-home"),
            XDG_STATE_HOME: join(state, "runner-state"),
          },
          detached: true,
          stdin: "ignore",
          stdout: log.fd,
          stderr: log.fd,
        },
      );
    } finally {
      await log.close();
    }

    const deadline = Date.now() + 60_000;
    while (
      Date.now() < deadline &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      signal.throwIfAborted();
      const response = await fetch(`${url}/api/health`, {
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
      }).catch(() => undefined);
      await response?.body?.cancel();
      if (response?.ok) {
        return await use({ url, credentials: join(state, `${stage}.env`) });
      }
      await setTimeout(200, undefined, { signal });
    }
    signal.throwIfAborted();
    throw new Error(`Dev server failed to start. Check ${logPath}.`);
  } finally {
    if (child) await stopProcessGroup(child);
  }
}
