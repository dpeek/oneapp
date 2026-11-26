import { Schema } from "effect";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { ItemId } from "../../apps/web/src/items-contract.ts";
import { recordRunEvent } from "./events.ts";
import { GitSha, type ProductionDeployment } from "./github.ts";

const Deployment = Schema.Struct({
  taskId: ItemId,
  revision: ItemId,
  sha: GitSha,
  origin: Schema.String,
  repository: Schema.String,
  createdAt: Schema.Int,
});
type Deployment = typeof Deployment.Type;
const deploymentTimeout = 30 * 60_000;
const pollInterval = 10_000;

export async function savePendingDeployment(
  directory: string,
  run: string,
  deployment: Omit<Deployment, "createdAt">,
) {
  const pending = join(directory, "deployments");
  await mkdir(pending, { recursive: true, mode: 0o700 });
  const file = join(pending, `${basename(run)}.json`);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify({ ...deployment, createdAt: Date.now() }) + "\n",
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function watchDeployments(options: {
  directory: string;
  origin: string;
  repository: string;
  signal: AbortSignal;
  implementationFinished?: AbortSignal;
  checks: () => (sha: string) => Promise<ProductionDeployment | undefined>;
  complete: (
    taskId: string,
    revision: string,
  ) => Promise<"completed" | "changed">;
}) {
  const { directory, origin, repository, signal, implementationFinished } =
    options;
  const pending = join(directory, "deployments");
  const reported = new Map<string, string>();
  let timedOut = false;

  while (!signal.aborted) {
    // Read this before scanning. A finishing implementation can add a file
    // while we scan and must get a subsequent pass in --once mode.
    const implementationDone = implementationFinished?.aborted;
    const names = await readdir(pending).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const check = options.checks();
    let waiting = false;
    for (const name of names) {
      if (signal.aborted) return;
      if (!name.endsWith(".json")) continue;
      const file = join(pending, name);
      const deployment = Schema.decodeUnknownSync(Deployment)(
        JSON.parse(await readFile(file, "utf8")),
      );
      if (deployment.origin !== origin || deployment.repository !== repository)
        continue;
      const { taskId, revision, sha, createdAt } = deployment;
      const run = join(directory, name.slice(0, -5));
      const record = (phase: string, detail: Record<string, unknown>) =>
        recordRunEvent(run, taskId, origin, phase, { sha, ...detail });
      let production: ProductionDeployment | undefined;
      let reason: string | undefined;
      try {
        production = await check(sha);
        if (signal.aborted) return;
        if (production?.conclusion === "success") {
          const status = await options.complete(taskId, revision);
          await record(
            status === "completed" ? "completed" : "completion-skipped",
            {
              deployedSha: production.sha,
              buildUrl: production.buildUrl,
              ...(status === "changed"
                ? { reason: "The task changed after it was claimed." }
                : {}),
            },
          );
          await rm(file);
          reported.delete(name);
          continue;
        }
        if (production?.conclusion)
          reason = `Cloudflare reported ${production.conclusion}.`;
      } catch (error) {
        if (signal.aborted) return;
        reason = error instanceof Error ? error.message : String(error);
      }

      const buildUrl = production?.buildUrl;
      if (Date.now() - createdAt >= deploymentTimeout) {
        await record("deployment-timeout", {
          reason:
            reason ?? "No successful production deployment after 30 minutes.",
          buildUrl,
        });
        await rm(file);
        reported.delete(name);
        timedOut = true;
        continue;
      }
      if (reason && reported.get(name) !== reason) {
        await record(
          production?.conclusion && production.conclusion !== "success"
            ? "deployment-failed"
            : "deployment-waiting",
          { reason, buildUrl },
        );
        reported.set(name, reason);
      }
      waiting = true;
    }

    if (implementationDone && !waiting) {
      if (timedOut)
        throw new Error("A deployment timed out. Check the runner logs.");
      return;
    }
    const wake =
      implementationFinished && !implementationDone
        ? AbortSignal.any([signal, implementationFinished])
        : signal;
    await setTimeout(pollInterval, undefined, { signal: wake }).catch(
      (error) => {
        if (!wake.aborted) throw error;
      },
    );
  }
}
