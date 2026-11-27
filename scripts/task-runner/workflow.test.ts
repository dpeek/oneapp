import { Effect } from "effect";
import { expect, it } from "@effect/vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { preparePendingPush, watchDeployments } from "./deployments.ts";
import { PublishQueue } from "./publish-queue.ts";
import {
  captureCommand,
  commandEnv,
  createWorkflow,
  withWorkflowServer,
} from "./workflow.ts";

const exerciseWorkflow = () =>
  Effect.promise(async () => {
    const root = await mkdtemp(join(tmpdir(), "orumai-workflow-"));
    const signal = AbortSignal.timeout(25_000);
    const remote = join(root, "remote.git");
    const upstream = join(root, "upstream");
    const mirror = join(root, "mirror.git");
    const repo = join(root, "repo");
    const attempt = join(root, "attempt");
    const origin = "https://orumai.example";
    const repository = "example/fixture";
    const taskId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const revision = crypto.randomUUID();
    const git = async (cwd: string, ...args: string[]) => {
      const result = await captureCommand(
        [
          "git",
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        cwd,
        signal,
      );
      if (result.exitCode !== 0) throw new Error(result.stderr);
      return result.stdout;
    };
    const commit = async (cwd: string, message: string) => {
      await git(cwd, "add", ".");
      await git(cwd, "commit", "-m", message);
      return git(cwd, "rev-parse", "HEAD");
    };

    try {
      await git(root, "init", "--bare", "--initial-branch=main", remote);
      await git(root, "clone", remote, upstream);
      await Bun.write(
        join(upstream, "package.json"),
        JSON.stringify({
          name: "workflow-fixture",
          scripts: {
            check: "echo fixture check",
            test: "bun fixture-test.ts",
            build: "echo fixture build",
          },
        }),
      );
      await Bun.write(
        join(upstream, "fixture-test.ts"),
        `
        if ((await Bun.file("message.txt").text()).trim() === "broken") {
          console.error(new Error("fixture test: expected a valid message"));
          process.exit(7);
        }
      `,
      );
      await Bun.write(join(upstream, "message.txt"), "initial\n");
      await commit(upstream, "Initial");
      await git(upstream, "push", "origin", "main");
      await git(root, "clone", "--bare", "--no-local", remote, mirror);
      await git(root, "clone", "--no-local", mirror, repo);
      await mkdir(attempt);

      const secondMirror = join(root, "second-mirror.git");
      const secondRepo = join(root, "second-repo");
      const secondRun = join(root, "second-attempt");
      await mkdir(secondRun);
      await git(root, "clone", "--bare", "--no-local", remote, secondMirror);
      await git(root, "clone", "--no-local", secondMirror, secondRepo);
      await Bun.write(join(secondRepo, "second.txt"), "second candidate\n");
      const secondCandidate = await commit(secondRepo, "Second candidate");
      const publishQueue = new PublishQueue();
      const phases = ["setup", "implementation"];
      let advanceDuringChecks: (() => Promise<void>) | undefined;
      let tracked: string | undefined;
      let mayPublish = true;
      let confirmed = false;
      const watch = {
        directory: root,
        origin,
        repository,
        complete: async () => {
          throw new Error("An active run must be completed through Activity.");
        },
        report: async (
          _id: string,
          _run: string,
          update: { phase: string },
        ) => {
          if (update.phase === "finished") {
            expect(confirmed).toBe(true);
            phases.push(update.phase);
          }
          return "updated" as const;
        },
      };
      const workflowOptions: Parameters<typeof createWorkflow>[0] = {
        repo,
        mirror,
        run: root,
        sandbox: [],
        env: commandEnv,
        signal,
        queue: publishQueue,
        waiting: async () => {},
        publishing: async () => {},
        waitForProduction: async () => {},
        checking: async () => {
          phases.push("checks");
          const advance = advanceDuringChecks;
          advanceDuringChecks = undefined;
          await advance?.();
        },
        working: async () => {
          phases.push("implementation");
        },
        preparePush: async (sha, summary) => {
          if (!mayPublish)
            throw new Error("The task changed after it was claimed.");
          const release = await preparePendingPush(root, attempt, {
            taskId,
            runId,
            revision,
            sha,
            origin,
            repository,
            ...(summary ? { summary } : {}),
          });
          await watchDeployments({
            ...watch,
            signal,
            implementationFinished: AbortSignal.abort(),
            checks: () => async () => {
              throw new Error(
                "A push in flight must stay out of the deployment watcher.",
              );
            },
          });
          return release;
        },
        trackPush: async (sha, summary, accepted) => {
          expect(accepted).toBe(true);
          expect(summary).toBe("Verified the fixture.");
          tracked = sha;
          phases.push("deployment");
        },
      };
      const workflow = createWorkflow(workflowOptions);
      const secondQueued = Promise.withResolvers<void>();
      const secondChecking = Promise.withResolvers<string>();
      const allowSecondVerify = Promise.withResolvers<void>();
      const secondReadyToPush = Promise.withResolvers<string>();
      const secondSafeToPush = Promise.withResolvers<void>();
      const second = createWorkflow({
        ...workflowOptions,
        repo: secondRepo,
        mirror: secondMirror,
        run: secondRun,
        waiting: async () => secondQueued.resolve(),
        checking: async (sha) => {
          secondChecking.resolve(sha);
          await allowSecondVerify.promise;
        },
        working: async () => {},
        waitForProduction: async (sha) => {
          secondReadyToPush.resolve(sha);
          await secondSafeToPush.promise;
        },
        preparePush: async () => async () => {},
        trackPush: async () => {},
      });
      let secondTurn: Promise<Awaited<ReturnType<typeof second.dispatch>>>;

      const client = fileURLToPath(
        new URL("./workflow-client.ts", import.meta.url),
      );
      await withWorkflowServer(workflow, async (env) => {
        const command = (...args: string[]) =>
          captureCommand(
            [process.execPath, "--no-env-file", client, ...args],
            repo,
            signal,
            {
              ...commandEnv,
              ...env,
            },
          );
        const fetchMain = async () => {
          expect(await command("fetch")).toMatchObject({ exitCode: 0 });
          await git(repo, "fetch", "origin");
        };

        await Bun.write(join(repo, "message.txt"), "broken\n");
        expect((await command("fetch")).stderr).toContain(
          "uncommitted changes",
        );
        await commit(repo, "Broken candidate");
        await fetchMain();
        secondTurn = second.dispatch("fetch");
        await secondQueued.promise;
        const failed = await command("verify");
        expect(failed.exitCode).toBe(7);
        expect(failed.stderr).toContain("bun run test failed (exit 7)");
        expect(failed.stderr).toContain(
          "fixture test: expected a valid message",
        );
        expect(failed.stderr).toContain("fixture-test.ts");
        expect(phases).toEqual([
          "setup",
          "implementation",
          "checks",
          "implementation",
        ]);
        expect((await command("publish")).stderr).toContain(
          "no successful verification",
        );

        await Bun.write(join(repo, "message.txt"), "working\n");
        await git(repo, "add", "message.txt");
        await git(repo, "commit", "--amend", "-m", "Fix candidate");
        const first = await git(repo, "rev-parse", "HEAD");
        advanceDuringChecks = async () => {
          await Bun.write(join(upstream, "other.txt"), "upstream advance\n");
          await commit(upstream, "Advance during verification");
          await git(upstream, "push", "origin", "main");
        };
        expect(await command("verify")).toMatchObject({
          exitCode: 0,
          stdout: `Verified ${first}.`,
        });
        expect((await command("verify")).stdout).toBe(
          `Verified ${first} (cached).`,
        );
        const rejected = await command("publish");
        expect(rejected.exitCode).not.toBe(0);
        expect(rejected.stderr).toContain("Push rejected. Fetch, rebase");
        expect(await readdir(join(root, "deployments"))).toEqual([]);
        expect(phases.at(-1)).toBe("implementation");
        expect((await command("verify")).stderr).toContain("Run Fetch");

        await fetchMain();
        await git(repo, "rebase", "origin/main");
        const rebased = await git(repo, "rev-parse", "HEAD");
        expect(rebased).not.toBe(first);
        expect((await command("publish")).stderr).toContain(
          `HEAD ${rebased} has no successful verification`,
        );
        expect(await command("verify")).toMatchObject({ exitCode: 0 });

        await Bun.write(
          join(upstream, "message.txt"),
          "overlapping upstream change\n",
        );
        await commit(upstream, "Advance with conflict");
        await git(upstream, "push", "origin", "main");
        expect((await command("publish")).stderr).toContain(
          "Push rejected. Fetch, rebase",
        );
        await fetchMain();
        await expect(git(repo, "rebase", "origin/main")).rejects.toThrow();
        await writeFile(join(repo, "message.txt"), "resolved\n");
        await git(repo, "add", "message.txt");
        expect((await command("verify")).stderr).toContain(
          "Finish it before continuing",
        );
        await git(repo, "-c", "core.editor=true", "rebase", "--continue");

        const resolved = await git(repo, "rev-parse", "HEAD");
        expect(await command("verify")).toMatchObject({
          exitCode: 0,
          stdout: `Verified ${resolved}.`,
        });
        mayPublish = false;
        expect((await command("publish")).stderr).toContain(
          "task changed after it was claimed",
        );
        mayPublish = true;
        expect(await command("publish", "Verified the fixture.")).toMatchObject(
          {
            exitCode: 0,
            stdout: `Published ${resolved}. The runner is tracking deployment.`,
          },
        );
        expect(tracked).toBe(resolved);
        expect(await git(remote, "rev-parse", "main")).toBe(resolved);
        expect(phases.at(-1)).toBe("deployment");
        const log = await readFile(join(root, "verify.log"), "utf8");
        expect(log.match(/bun install --frozen-lockfile/g)).toHaveLength(4);
        expect(log.match(/bun run build/g)).toHaveLength(3);
      });

      expect(await secondTurn!).toMatchObject({
        exitCode: 0,
        message: expect.stringContaining(tracked!),
      });
      await git(secondRepo, "fetch", "origin");
      expect((await second.dispatch("verify")).message).toContain("rebased");
      await git(secondRepo, "rebase", "origin/main");
      const secondRebased = await git(secondRepo, "rev-parse", "HEAD");
      expect(secondRebased).not.toBe(secondCandidate);
      expect(await git(secondRepo, "rev-parse", "HEAD^")).toBe(tracked);
      const secondVerify = second.dispatch("verify");
      expect(await secondChecking.promise).toBe(secondRebased);

      const firstPoll = new AbortController();
      const pendingPhases: string[] = [];
      await watchDeployments({
        ...watch,
        signal: firstPoll.signal,
        checks: () => async (sha) => ({
          sha,
          buildUrl: null,
          conclusion: null,
        }),
        report: async (id, run, update) => {
          pendingPhases.push(update.phase);
          if (update.phase === "heartbeat") firstPoll.abort();
          return watch.report(id, run, update);
        },
      });
      expect(pendingPhases).toEqual(["deployment", "heartbeat"]);
      expect(phases.at(-1)).toBe("deployment");
      expect(await readdir(join(root, "deployments"))).toHaveLength(1);
      allowSecondVerify.resolve();
      expect(await secondVerify).toEqual({
        exitCode: 0,
        message: `Verified ${secondRebased}.`,
      });
      const secondPush = second.dispatch("publish");
      expect(await secondReadyToPush.promise).toBe(tracked);
      expect(await git(remote, "rev-parse", "main")).toBe(tracked);

      confirmed = true;
      await watchDeployments({
        ...watch,
        signal,
        implementationFinished: AbortSignal.abort(),
        checks: () => async (sha) => {
          expect(sha).toBe(tracked);
          return { sha, buildUrl: null, conclusion: "success" };
        },
      });
      expect(phases.at(-1)).toBe("finished");
      expect(await readdir(join(root, "deployments"))).toEqual([]);
      secondSafeToPush.resolve();
      expect(await secondPush).toMatchObject({ exitCode: 0 });
      expect(await git(remote, "rev-parse", "main")).toBe(secondRebased);

      await Bun.write(join(repo, "message.txt"), "another candidate\n");
      await commit(repo, "Another candidate");
      const timedOut = createWorkflow({
        ...workflowOptions,
        slotTimeoutMs: 500,
      });
      expect(await timedOut.dispatch("fetch")).toMatchObject({ exitCode: 0 });
      const afterTimeout = createWorkflow(workflowOptions);
      expect(await afterTimeout.dispatch("fetch")).toMatchObject({
        exitCode: 0,
      });
      expect((await timedOut.dispatch("publish")).message).toContain(
        "timed out holding the publish slot",
      );
      await afterTimeout.close();

      const canceled = new AbortController();
      const canceledWorkflow = createWorkflow({
        ...workflowOptions,
        signal: canceled.signal,
      });
      expect(await canceledWorkflow.dispatch("fetch")).toMatchObject({
        exitCode: 0,
      });
      const thirdQueued = Promise.withResolvers<void>();
      const uncertainWorkflow = createWorkflow({
        ...workflowOptions,
        waiting: async () => thirdQueued.resolve(),
        trackPush: async (sha, _summary, accepted) => {
          expect(accepted).toBe(false);
          tracked = sha;
        },
      });
      const thirdTurn = uncertainWorkflow.dispatch("fetch");
      await thirdQueued.promise;
      canceled.abort(new Error("Canceled fixture run."));
      expect((await canceledWorkflow.dispatch("verify")).message).toBe(
        "Canceled fixture run.",
      );
      expect(await thirdTurn).toMatchObject({
        exitCode: 0,
      });
      await git(repo, "fetch", "origin");
      await git(repo, "rebase", "origin/main");
      const uncertain = await git(repo, "rev-parse", "HEAD");
      await git(
        mirror,
        "remote",
        "set-url",
        "--push",
        "origin",
        join(root, "unavailable.git"),
      );
      await git(
        mirror,
        "remote",
        "set-url",
        "origin",
        join(root, "missing.git"),
      );
      expect(await uncertainWorkflow.dispatch("verify")).toMatchObject({
        exitCode: 0,
      });
      expect((await uncertainWorkflow.dispatch("publish")).message).toContain(
        "Push acceptance is uncertain",
      );
      expect(tracked).toBe(uncertain);
      expect(await readdir(join(root, "deployments"))).toEqual([
        "attempt.json",
      ]);
      expect((await uncertainWorkflow.dispatch("publish")).message).toContain(
        "already tracking",
      );
      const next = createWorkflow(workflowOptions);
      expect((await next.dispatch("fetch")).message).toContain(
        "could not reconcile the push",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

// Let the subprocess deadline expire before Vitest interrupts cleanup.
it.effect(
  "publishes FIFO, repairs conflicts and external advances, and tracks a deploy during the next verification",
  exerciseWorkflow,
  30_000,
);
