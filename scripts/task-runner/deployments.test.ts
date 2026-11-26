import { expect, it } from "@effect/vitest";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { savePendingDeployment, watchDeployments } from "./deployments.ts";
import type { TaskRunUpdate } from "../../apps/web/src/task-run-contract.ts";

const origin = "https://oneapp.example";
const repository = "example/oneapp";

async function pendingRun(directory: string, sha: string, runId?: string) {
  const taskId = crypto.randomUUID();
  const revision = crypto.randomUUID();
  const run = join(directory, taskId);
  await mkdir(run);
  await savePendingDeployment(directory, run, {
    taskId,
    ...(runId ? { runId } : {}),
    revision,
    sha,
    origin,
    repository,
  });
  return { run, taskId, revision, sha };
}

it("can publish another run while a deployment check is in flight", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orumai-deployments-"));
  const shutdown = new AbortController();
  const finished = new AbortController();
  const checking = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let watcher: Promise<void> | undefined;
  try {
    const firstRun = crypto.randomUUID();
    const secondRun = crypto.randomUUID();
    const first = await pendingRun(directory, "1".repeat(40), firstRun);
    const complete = new Map<string, string>();
    watcher = watchDeployments({
      directory,
      origin,
      repository,
      signal: shutdown.signal,
      implementationFinished: finished.signal,
      checks: () => async (sha) => {
        if (sha === first.sha) {
          checking.resolve();
          await release.promise;
        }
        return { sha, buildUrl: null, conclusion: "success" };
      },
      complete: async () => {
        throw new Error("Run must be completed through the activity tool");
      },
      report: async (id, runId, update) => {
        expect(update).toMatchObject({
          phase: "finished",
          outcome: "deployed",
        });
        complete.set(id, runId);
        return "updated";
      },
    });
    await Promise.race([checking.promise, watcher]);
    const next = await pendingRun(directory, "2".repeat(40), secondRun);
    expect(complete.size).toBe(0);
    finished.abort();
    release.resolve();
    await watcher;
    expect(complete).toEqual(
      new Map([
        [first.taskId, firstRun],
        [next.taskId, secondRun],
      ]),
    );
    expect(await readdir(join(directory, "deployments"))).toEqual([]);
  } finally {
    shutdown.abort();
    release.resolve();
    if (watcher) await Promise.allSettled([watcher]);
    await rm(directory, { recursive: true, force: true });
  }
});

it("reconciles a persisted deployment on restart and records a changed task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orumai-deployments-"));
  try {
    const { run, taskId, revision, sha } = await pendingRun(
      directory,
      "3".repeat(40),
    );
    const shutdown = new AbortController();
    const common = {
      directory,
      origin,
      repository,
      report: async () => {
        throw new Error("Legacy deployment has no run ID");
      },
    };
    await watchDeployments({
      ...common,
      signal: shutdown.signal,
      checks: () => async () => {
        shutdown.abort();
        return undefined;
      },
      complete: async () => {
        throw new Error("Deploy still pending");
      },
    });
    expect(await readdir(join(directory, "deployments"))).toHaveLength(1);
    const buildUrl = "https://dash.cloudflare.com/build";
    await watchDeployments({
      ...common,
      signal: AbortSignal.timeout(3_000),
      implementationFinished: AbortSignal.abort(),
      checks: () => async () => ({ sha, buildUrl, conclusion: "success" }),
      complete: async (id, expectedRevision) => {
        expect(id).toBe(taskId);
        expect(expectedRevision).toBe(revision);
        return "changed";
      },
    });
    const event = JSON.parse(await readFile(join(run, "run.jsonl"), "utf8"));
    expect(event).toMatchObject({
      phase: "completion-skipped",
      deployedSha: sha,
      buildUrl,
    });
    expect(await readdir(join(directory, "deployments"))).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("reports a concluded production failure against the journaled run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orumai-deployments-"));
  try {
    const runId = crypto.randomUUID();
    const { taskId } = await pendingRun(directory, "4".repeat(40), runId);
    const deploymentUrl = "https://dash.cloudflare.com/failed-build";
    const reports: Array<{ id: string; run: string; update: TaskRunUpdate }> =
      [];
    await expect(
      watchDeployments({
        directory,
        origin,
        repository,
        signal: AbortSignal.timeout(3_000),
        implementationFinished: AbortSignal.abort(),
        checks: () => async (sha) => ({
          sha,
          buildUrl: deploymentUrl,
          conclusion: "failure",
        }),
        complete: async () => {
          throw new Error("Deployment did not succeed");
        },
        report: async (id, run, update) => {
          reports.push({ id, run, update });
          return "updated";
        },
      }),
    ).rejects.toThrow("A production deployment failed.");
    expect(reports).toEqual([
      {
        id: taskId,
        run: runId,
        update: {
          phase: "finished",
          outcome: "deployment-failed",
          reason: "Cloudflare reported failure.",
          deploymentUrl,
        },
      },
    ]);
    expect(await readdir(join(directory, "deployments"))).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
