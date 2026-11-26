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
import {
  TaskRunSummary,
  type TaskRunUpdate,
} from "../../apps/web/src/task-run-contract.ts";
import { recordRunEvent } from "./events.ts";
import { GitSha, type ProductionDeployment } from "./github.ts";

const Deployment = Schema.Struct({
  taskId: ItemId,
  runId: Schema.optionalKey(ItemId),
  revision: ItemId,
  sha: GitSha,
  origin: Schema.String,
  repository: Schema.String,
  createdAt: Schema.Int,
  activate: Schema.optionalKey(Schema.Literal(true)),
  summary: Schema.optionalKey(TaskRunSummary),
});
type Deployment = typeof Deployment.Type;
const deploymentTimeout = 30 * 60_000;
const pollInterval = 10_000;
const pushesInFlight = new Set<string>();

const deploymentFile = (directory: string, run: string) =>
  join(directory, "deployments", `${basename(run)}.json`);

export async function savePendingDeployment(
  directory: string,
  run: string,
  deployment: Omit<Deployment, "createdAt">,
) {
  const pending = join(directory, "deployments");
  await mkdir(pending, { recursive: true, mode: 0o700 });
  const file = deploymentFile(directory, run);
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

export async function preparePendingPush(
  directory: string,
  run: string,
  deployment: Omit<Deployment, "createdAt" | "activate">,
) {
  // Persist before sending the push. A restart can reconcile this candidate
  // if the process exited before it learned whether the push was accepted.
  const file = deploymentFile(directory, run);
  pushesInFlight.add(file);
  try {
    await savePendingDeployment(directory, run, {
      ...deployment,
      activate: true,
    });
  } catch (error) {
    pushesInFlight.delete(file);
    throw error;
  }
  return async (track: boolean) => {
    if (!track) await rm(file, { force: true });
    pushesInFlight.delete(file);
  };
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
  report: (
    taskId: string,
    runId: string,
    update: TaskRunUpdate,
  ) => Promise<"updated" | "stale" | "completion-skipped">;
}) {
  const { directory, origin, repository, signal, implementationFinished } =
    options;
  const pending = join(directory, "deployments");
  const reported = new Map<string, string>();
  const activated = new Set<string>();
  let failed = false;

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
      if (pushesInFlight.has(file)) continue;
      const json = await readFile(file, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
      if (json === undefined) continue;
      const deployment = Schema.decodeUnknownSync(Deployment)(JSON.parse(json));
      if (deployment.origin !== origin || deployment.repository !== repository)
        continue;
      const { taskId, runId, revision, sha, createdAt } = deployment;
      const run = join(directory, name.slice(0, -5));
      const record = (phase: string, detail: Record<string, unknown>) =>
        recordRunEvent(run, taskId, origin, phase, { sha, ...detail });
      let production: ProductionDeployment | undefined;
      let reason: string | undefined;
      try {
        production = await check(sha);
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
      if (signal.aborted) return;
      const deploymentUrl = production?.buildUrl ?? undefined;
      const timeout = Date.now() - createdAt >= deploymentTimeout;
      try {
        if (deployment.activate && runId && !activated.has(name)) {
          await options.report(taskId, runId, {
            phase: "deployment",
            ...(deployment.summary ? { summary: deployment.summary } : {}),
          });
          activated.add(name);
        }
        if (production?.conclusion === "success") {
          const status = runId
            ? await options.report(taskId, runId, {
                phase: "finished",
                outcome: "deployed",
                deploymentUrl,
              })
            : await options.complete(taskId, revision);
          await record(
            status === "completed" || status === "updated"
              ? "completed"
              : "completion-skipped",
            {
              deployedSha: production.sha,
              buildUrl: production.buildUrl,
              ...(status !== "completed" && status !== "updated"
                ? { reason: "The task changed after it was claimed." }
                : {}),
            },
          );
          await rm(file);
          reported.delete(name);
          activated.delete(name);
          continue;
        }
        if (production?.conclusion)
          reason = `Cloudflare reported ${production.conclusion}.`;
        if (timeout || (runId && production?.conclusion)) {
          const status = runId
            ? await options.report(taskId, runId, {
                phase: "finished",
                outcome: "deployment-failed",
                reason: reason?.slice(0, 2_000),
                deploymentUrl,
              })
            : "updated";
          if (status === "stale") {
            await record("deployment-tracking-skipped", {
              reason: "This run is no longer active.",
            });
          } else {
            await record(timeout ? "deployment-timeout" : "deployment-failed", {
              reason:
                reason ??
                "No successful production deployment after 30 minutes.",
              buildUrl: deploymentUrl,
            });
            failed = true;
          }
          await rm(file);
          reported.delete(name);
          activated.delete(name);
          continue;
        }
        if (
          runId &&
          (await options.report(taskId, runId, {
            phase: "heartbeat",
            activePhase: "deployment",
            deploymentUrl,
          })) === "stale"
        ) {
          await record("deployment-tracking-skipped", {
            reason: "This run is no longer active.",
          });
          await rm(file);
          reported.delete(name);
          activated.delete(name);
          continue;
        }
      } catch (error) {
        if (signal.aborted) return;
        reason = error instanceof Error ? error.message : String(error);
      }

      if (reason && reported.get(name) !== reason) {
        await record(
          production?.conclusion && production.conclusion !== "success"
            ? "deployment-failed"
            : "deployment-waiting",
          { reason, buildUrl: deploymentUrl },
        );
        reported.set(name, reason);
      }
      if (timeout) failed = true;
      else waiting = true;
    }

    if (implementationDone && !waiting) {
      if (failed)
        throw new Error(
          "A production deployment failed. Check the runner logs.",
        );
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
