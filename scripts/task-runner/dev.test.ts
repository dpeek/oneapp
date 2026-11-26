import { expect, it } from "@effect/vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDevServer } from "./dev.ts";

it("stops the dev server's children when the agent fails", async () => {
  const repo = await mkdtemp(join(tmpdir(), "orumai-runner-test-"));
  const pidFile = join(repo, "server.pid");
  try {
    await Promise.all([
      writeFile(
        join(repo, "package.json"),
        JSON.stringify({ scripts: { dev: "bun launcher.ts" } }),
      ),
      writeFile(
        join(repo, "launcher.ts"),
        `const child = Bun.spawn([process.execPath, "server.ts", process.argv.at(-1)]);
await Bun.write("server.pid", String(child.pid));
await child.exited;`,
      ),
      writeFile(
        join(repo, "server.ts"),
        `Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.argv.at(-1)),
  fetch: () => Response.json({ ok: true }),
});`,
      ),
    ]);

    let healthUrl: string | undefined;
    await expect(
      withDevServer(
        {
          repo,
          logPath: join(repo, "dev.log"),
          commandPrefix: [],
          env: { PATH: process.env.PATH },
          signal: AbortSignal.timeout(10_000),
        },
        async ({ url }) => {
          healthUrl = new URL("/api/health", url).href;
          expect((await fetch(healthUrl)).ok).toBe(true);
          throw new Error("Agent failed.");
        },
      ),
    ).rejects.toThrow("Agent failed.");
    expect(healthUrl).toBeDefined();
    await expect(
      fetch(healthUrl!, { signal: AbortSignal.timeout(1_000) }),
    ).rejects.toThrow();
  } finally {
    // Avoid leaving the fixture listening if the regression check fails.
    const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await rm(repo, { recursive: true, force: true });
  }
});
