import { defaultServerUrl } from "../packages/core/src/index.ts";
import {
  CliTokenSecret,
  taskRunnerScopes,
} from "../packages/core/src/cli-auth.ts";
import { serverOrigin } from "../apps/cli/src/credentials.ts";
import { browserLogin } from "../apps/cli/src/login.ts";
import { taskPath } from "../apps/web/src/tasks-contract.ts";
import { Effect, Redacted, Schema } from "effect";
import { mkdir, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { watchDeployments } from "./task-runner/deployments.ts";
import { githubRepository, productionChecks } from "./task-runner/github.ts";
import { TaskQueue } from "./task-runner/queue.ts";
import { gitOrigin, resolveBunCache, runNext } from "./task-runner/run.ts";
import { configureBrowser, resolveBrowser } from "./task-runner/settings.ts";

const usage = `Usage: bun --no-env-file run tasks:runner [--server <origin>] [--once | --dry-run]
       bun --no-env-file run tasks:runner --login [--no-browser] [--server <origin>]
       bun --no-env-file run tasks:runner --configure-browser <executable>

Picks up one not-started task tagged ready at a time. A successful run pushes
to origin/main and tracks production deployment. --once attempts one task
and follows pending deployments. --dry-run lists the next eligible task.`;
const credentialService = "orumai-task-runner";

async function main() {
  const { values } = parseArgs({
    options: {
      server: { type: "string", default: defaultServerUrl },
      login: { type: "boolean" },
      "no-browser": { type: "boolean" },
      "dry-run": { type: "boolean" },
      once: { type: "boolean" },
      "configure-browser": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (values["configure-browser"] !== undefined) {
    if (
      values.login ||
      values["no-browser"] ||
      values.once ||
      values["dry-run"]
    )
      throw new Error(usage);
    const executable = await configureBrowser(values["configure-browser"]);
    console.log(`Saved Chrome Headless Shell at ${executable}.`);
    return;
  }
  const origin = serverOrigin(values.server);
  if (values.login) {
    if (values.once || values["dry-run"]) throw new Error(usage);
    const token = await Effect.runPromise(
      browserLogin(
        origin,
        !values["no-browser"],
        "Orumai task runner",
        taskRunnerScopes,
      ),
    );
    await Bun.secrets.set({
      service: credentialService,
      name: origin,
      value: Redacted.value(token),
      persist: "local",
    });
    console.log(`Saved runner access for ${origin}.`);
    return;
  }
  if (values["no-browser"]) throw new Error(usage);
  const token =
    process.env.ORUMAI_RUNNER_TOKEN ??
    (await Bun.secrets.get({ service: credentialService, name: origin }));
  if (!Schema.is(CliTokenSecret)(token))
    throw new Error(
      "No valid runner credential. Run tasks:runner --login first.",
    );

  const shutdown = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => shutdown.abort());
  const { signal } = shutdown;
  if (values["dry-run"]) {
    const queue = new TaskQueue(origin, token, signal);
    try {
      await queue.connect();
      const next = await queue.next();
      console.log(
        next
          ? `Next eligible task: ${new URL(taskPath(next.id), origin)}`
          : "No eligible tasks.",
      );
    } finally {
      await queue.close();
    }
    return;
  }

  const source = resolve(import.meta.dir, "..");
  const remote = await gitOrigin(source, signal);
  const repository = githubRepository(remote);
  if (!Bun.which("codex"))
    throw new Error("Install the Codex CLI on the runner.");
  if (!Bun.which("gh"))
    throw new Error(
      "Install the GitHub CLI and sign in to read deployment checks.",
    );
  const browser = await resolveBrowser();
  const bunCache = await resolveBunCache(source, signal);
  const directory = join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "orumai-task-runner",
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, ".lock");
  const lock = await open(lockPath, "wx", 0o600).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      throw new Error(
        `A runner holds ${lockPath}. Remove the lock only after confirming that runner has stopped.`,
      );
    },
  );
  try {
    await lock.writeFile(String(process.pid));
    const implementationFinished = new AbortController();
    const withQueue = async <A>(use: (queue: TaskQueue) => Promise<A>) => {
      const queue = new TaskQueue(origin, token, signal);
      try {
        await queue.connect();
        return await use(queue);
      } finally {
        await queue.close();
      }
    };
    const implement = async () => {
      while (!signal.aborted) {
        let pushed = false;
        try {
          pushed = Boolean(
            await withQueue((queue) =>
              runNext(queue, {
                origin,
                source,
                remote,
                repository,
                directory,
                signal,
                browser,
                bunCache,
              }),
            ),
          );
        } catch (error) {
          if (signal.aborted) return;
          if (values.once) throw error;
          console.error(error instanceof Error ? error.message : String(error));
        }
        if (values.once) return;
        if (!pushed)
          await setTimeout(60_000, undefined, { signal }).catch((error) => {
            if (!signal.aborted) throw error;
          });
      }
    };
    const implementations = implement().finally(() =>
      implementationFinished.abort(),
    );
    const deployments = watchDeployments({
      directory,
      origin,
      repository,
      signal,
      implementationFinished: values.once
        ? implementationFinished.signal
        : undefined,
      checks: () => productionChecks(repository, signal),
      complete: (id, revision) =>
        withQueue((queue) => queue.complete(id, revision)),
      report: (id, runId, update) =>
        withQueue((queue) => queue.report(id, runId, update)),
    });
    try {
      await Promise.all([implementations, deployments]);
    } finally {
      shutdown.abort();
      await Promise.allSettled([implementations, deployments]);
    }
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
