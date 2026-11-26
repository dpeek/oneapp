import { constants, existsSync } from "node:fs";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type BrowserSession = {
  readonly cli: string;
  readonly env: Record<string, string | undefined>;
  readonly permission: string;
};

export async function withBrowserSession<T>(
  source: string,
  executable: string,
  runAgent: (browser: BrowserSession) => Promise<T>,
) {
  const cli = join(source, "node_modules", ".bin", "agent-browser");
  await access(cli, constants.X_OK);
  const directory = await mkdtemp(join(tmpdir(), "orumai-ab-"));
  const socketDirectory = await realpath(directory);
  const socket = join(socketDirectory, "run.sock");
  const pendingSocket = join(socketDirectory, "run.tmp");
  const config = join(socketDirectory, "config.json");
  const env = {
    ORUMAI_BROWSER: cli,
    AGENT_BROWSER_CONFIG: config,
    AGENT_BROWSER_EXECUTABLE_PATH: executable,
    // The runner host provisions the browser. Local sessions cannot reach the release feed.
    AGENT_BROWSER_NO_VERSION_CHECK: "1",
    AGENT_BROWSER_SESSION: "run",
    AGENT_BROWSER_SOCKET_DIR: socketDirectory,
  };
  try {
    await writeFile(
      config,
      JSON.stringify({
        allowedDomains: ["localhost", "127.0.0.1"],
        contentBoundaries: true,
        // Startup and Codex have separate network proxies. Keep the browser
        // on loopback inside the sandbox without changing its proxy per command.
        proxy: "direct://",
        idleTimeout: "35m",
        // Chromium's macOS child process rendezvous is unavailable in this sandbox.
        ...(process.platform === "darwin"
          ? {
              args: "--single-process,--in-process-gpu,--no-zygote,--disable-crash-reporter",
            }
          : {}),
      }),
      { mode: 0o600 },
    );
    // The daemon binds at the pending path and renames it to the session socket.
    const sockets = [socket, pendingSocket]
      .map((path) => `${JSON.stringify(path)}="allow"`)
      .join(",");
    return await runAgent({
      cli,
      env,
      permission: `permissions.orumai-runner.network.unix_sockets={${sockets}}`,
    });
  } finally {
    if (existsSync(socket)) {
      const close = Bun.spawn([cli, "close"], {
        cwd: source,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
        stdout: "ignore",
        stderr: "inherit",
        signal: AbortSignal.timeout(10_000),
      });
      if ((await close.exited) !== 0)
        throw new Error(
          `Could not close the runner's browser session at ${socketDirectory}.`,
        );
    }
    await rm(directory, { recursive: true, force: true });
  }
}
