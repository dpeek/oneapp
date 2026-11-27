import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { GitSha } from "./github.ts";
import { Schema } from "effect";
import { waitForProcessGroup } from "./processes.ts";
import type { PublishQueue } from "./publish-queue.ts";
import type { WorkflowResult } from "./workflow-client.ts";

const mainRef = "refs/heads/main";
const publishTimeoutMs = 15 * 60_000;
const maxMainAdvances = 2;
const statusArgs = [
  "status",
  "--porcelain",
  "--untracked-files=all",
  "--ignore-submodules=none",
];
const checks = [
  ["install", "--frozen-lockfile"],
  ["check"],
  ["run", "test"],
  ["run", "build"],
];

export const commandEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  LANG: process.env.LANG,
};

export const gitEnv = {
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
  SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
};

type CommandResult = { exitCode: number; stdout: string; stderr: string };

export async function captureCommand(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  env: Record<string, string | undefined> = commandEnv,
): Promise<CommandResult> {
  signal.throwIfAborted();
  const child = Bun.spawn(args, {
    cwd,
    detached: true,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    waitForProcessGroup(child, signal),
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function requireSuccess(command: string, result: CommandResult) {
  if (result.exitCode !== 0)
    throw new Error(
      `${command} failed (exit ${result.exitCode}). ${result.stderr}`.trim(),
    );
  return result.stdout;
}

const failure = (message: string, exitCode = 1): WorkflowResult => ({
  exitCode,
  message,
});
const success = (message: string): WorkflowResult => ({ exitCode: 0, message });

async function failureDetails(
  log: Awaited<ReturnType<typeof open>>,
  from: number,
) {
  const end = (await log.stat()).size;
  const size = Math.min(end - from, 8_000);
  const buffer = Buffer.alloc(size);
  await log.read(buffer, 0, size, end - size);
  return buffer
    .toString()
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .trim();
}

export function createWorkflow(options: {
  repo: string;
  mirror: string;
  run: string;
  sandbox: string[];
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  queue: PublishQueue;
  slotTimeoutMs?: number;
  waiting: () => Promise<void>;
  publishing: () => Promise<void>;
  waitForProduction: (sha: string, signal: AbortSignal) => Promise<void>;
  checking: (sha: string) => Promise<void>;
  working: (sha: string, result: WorkflowResult) => Promise<void>;
  preparePush: (
    sha: string,
    summary: string | undefined,
  ) => Promise<(track: boolean) => Promise<void>>;
  trackPush: (
    sha: string,
    summary: string | undefined,
    accepted: boolean,
    detail: string,
  ) => Promise<void>;
}) {
  const { repo, mirror, run, sandbox, env, queue } = options;
  const stopped = new AbortController();
  const signal = AbortSignal.any([options.signal, stopped.signal]);
  const localGitEnv = {
    ...commandEnv,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const logPath = join(run, "verify.log");
  let verified: string | undefined;
  let pendingActivity: { sha: string; result: WorkflowResult } | undefined;
  let ended: string | undefined;
  let active: Promise<WorkflowResult> | undefined;
  let slot: ReturnType<PublishQueue["request"]> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let fetched = false;
  let mainAdvances = 0;

  const releaseSlot = () => {
    clearTimeout(deadline);
    slot?.release();
    slot = undefined;
  };
  const abort = () => {
    if (!active) releaseSlot();
  };
  signal.addEventListener("abort", abort, { once: true });

  const git = async (args: string[], cwd = mirror) =>
    requireSuccess(
      `git ${args[0]}`,
      await captureCommand(["git", ...args], cwd, signal, localGitEnv),
    );
  const remoteGit = (args: string[], commandSignal = signal) =>
    captureCommand(["git", ...args], mirror, commandSignal, {
      ...commandEnv,
      ...gitEnv,
    });
  const sandboxGit = async (args: string[], cwd = repo) =>
    requireSuccess(
      `git ${args[0]}`,
      await captureCommand(
        [
          ...sandbox,
          "git",
          "--no-optional-locks",
          "-c",
          "core.fsmonitor=false",
          ...args,
        ],
        cwd,
        signal,
        env,
      ),
    );
  const cleanHead = async () => {
    const gitDir = await sandboxGit(["rev-parse", "--absolute-git-dir"]);
    for (const operation of [
      "rebase-merge",
      "rebase-apply",
      "sequencer",
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
    ]) {
      const inProgress = await stat(join(gitDir, operation)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
      if (inProgress)
        throw new Error(
          "A Git operation is in progress. Finish it before continuing.",
        );
    }
    if (await sandboxGit(statusArgs))
      throw new Error(
        "The checkout has uncommitted changes. Commit the candidate first.",
      );
    return Schema.decodeUnknownSync(GitSha)(
      await sandboxGit(["rev-parse", "HEAD"]),
    );
  };

  const refreshMirror = (commandSignal = signal) =>
    remoteGit(
      [
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "origin",
        `${mainRef}:${mainRef}`,
      ],
      commandSignal,
    );

  const fetchMain = async () => {
    if (!slot) {
      const sha = await cleanHead();
      if (sha === (await git(["rev-parse", mainRef])))
        return failure(
          "Commit the candidate before requesting the publish slot.",
        );
      slot = queue.request();
      try {
        if (slot.waiting) await options.waiting();
        await slot.enter(signal);
        deadline = setTimeout(() => {
          stopped.abort(
            new Error("The runner timed out holding the publish slot."),
          );
        }, options.slotTimeoutMs ?? publishTimeoutMs);
        await options.publishing();
      } catch (error) {
        releaseSlot();
        throw error;
      }
    }
    fetched = false;
    verified = undefined;
    try {
      requireSuccess("Fetch", await refreshMirror());
    } catch (error) {
      ended = signal.aborted ? undefined : String(error);
      throw error;
    }
    signal.throwIfAborted();
    fetched = true;
    return success(
      `Fetched main at ${await git(["rev-parse", mainRef])}. Run git fetch origin in the checkout.`,
    );
  };

  const checkSnapshot = async (sha: string, candidate: string) => {
    // A separate checkout keeps edits during verification from affecting the suite.
    const snapshot = await mkdtemp(join(run, "verify-"));
    try {
      await git(["init", "--quiet"], snapshot);
      await git(["fetch", "--no-tags", mirror, candidate], snapshot);
      await git(
        [
          "-c",
          "core.hooksPath=/dev/null",
          "checkout",
          "--quiet",
          "--detach",
          sha,
        ],
        snapshot,
      );
      const log = await open(logPath, "a+", 0o600);
      try {
        for (const args of checks) {
          const command = `bun ${args.join(" ")}`;
          await log.write(`\n[${sha}] ${command}\n`);
          const from = (await log.stat()).size;
          signal.throwIfAborted();
          const child = Bun.spawn(
            [...sandbox, process.execPath, "--no-env-file", ...args],
            {
              cwd: snapshot,
              env,
              detached: true,
              stdin: "ignore",
              stdout: log.fd,
              stderr: log.fd,
            },
          );
          const exitCode = await waitForProcessGroup(child, signal);
          if (exitCode !== 0)
            return failure(
              `${command} failed (exit ${exitCode}).\n${await failureDetails(log, from)}\nFull output: ${logPath}`,
              exitCode,
            );
        }
      } finally {
        await log.close();
      }
      if (
        (await sandboxGit(["rev-parse", "HEAD"], snapshot)) !== sha ||
        (await sandboxGit(statusArgs, snapshot))
      )
        return failure(
          `Verification changed the candidate checkout. Full output: ${logPath}`,
        );
      verified = sha;
      return success(`Verified ${sha}.`);
    } finally {
      await rm(snapshot, { recursive: true, force: true });
    }
  };

  const verify = async () => {
    if (!fetched)
      return failure("Run Fetch and rebase onto origin/main before Verify.");
    const sha = await cleanHead();
    const upstream = await git(["rev-parse", mainRef]);
    const candidate = `refs/orumai/candidates/${sha}`;
    // Copy the commit without credentials.
    await git([
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      repo,
      `${sha}:${candidate}`,
    ]);
    if (sha === upstream || !(await isAncestor(upstream, sha)))
      return failure(
        "Verify requires a candidate rebased onto the freshly fetched main.",
      );
    if (pendingActivity) {
      await options.working(pendingActivity.sha, pendingActivity.result);
      pendingActivity = undefined;
    }
    if (verified === sha) return success(`Verified ${sha} (cached).`);
    await options.checking(sha);
    const result = await checkSnapshot(sha, candidate).catch((error: unknown) =>
      failure(error instanceof Error ? error.message : String(error)),
    );
    pendingActivity = { sha, result };
    await options.working(sha, result);
    pendingActivity = undefined;
    return result;
  };

  const isAncestor = async (
    ancestor: string,
    sha: string,
    commandSignal = signal,
  ) => {
    const result = await captureCommand(
      ["git", "merge-base", "--is-ancestor", ancestor, sha],
      mirror,
      commandSignal,
      localGitEnv,
    );
    if (result.exitCode === 1) return false;
    requireSuccess("git merge-base", result);
    return true;
  };

  const reconcile = async (sha: string) => {
    // The slot stays held until a fresh remote read settles the push.
    const probe = AbortSignal.timeout(30_000);
    requireSuccess("Push reconciliation fetch", await refreshMirror(probe));
    const head = requireSuccess(
      "git rev-parse",
      await captureCommand(
        ["git", "rev-parse", mainRef],
        mirror,
        probe,
        localGitEnv,
      ),
    );
    return isAncestor(sha, head, probe);
  };

  const publish = async (summary: string | undefined) => {
    const sha = await cleanHead();
    if (!fetched || verified !== sha)
      return failure(
        `HEAD ${sha} has no successful verification. Run Verify before publishing.`,
      );
    const upstream = await git(["rev-parse", mainRef]);
    if (sha === upstream)
      return failure(
        "HEAD matches main. Commit the task changes before publishing.",
      );
    await options.waitForProduction(upstream, signal);
    if ((await cleanHead()) !== sha)
      return failure(
        "HEAD changed before publishing. Verify the current commit.",
      );
    const release = await options.preparePush(sha, summary);
    try {
      signal.throwIfAborted();
      if ((await cleanHead()) !== sha)
        throw new Error(
          "HEAD changed before pushing. Verify the current commit.",
        );
    } catch (error) {
      await release(false);
      throw error;
    }
    let accepted = false;
    let detail: string;
    let rejection: WorkflowResult | undefined;
    try {
      const result = await remoteGit([
        "push",
        "--porcelain",
        "--no-verify",
        "--no-follow-tags",
        "--recurse-submodules=no",
        "origin",
        `${sha}:${mainRef}`,
      ]);
      const status = result.stdout.split("\n").find((line) => {
        const [, refs] = line.split("\t");
        return refs?.endsWith(`:${mainRef}`);
      });
      if (status && /^!\t[^\t]+\t\[(?:remote )?rejected\]/.test(status)) {
        const advanced =
          /\((fetch first|non-fast-forward|failed to update ref)\)/.test(
            status,
          );
        if (advanced && ++mainAdvances <= maxMainAdvances) {
          fetched = false;
          verified = undefined;
          rejection = failure(
            `Push rejected. Fetch, rebase onto origin/main, and verify again.\n${status}`,
          );
        } else {
          ended = advanced
            ? `Main kept advancing. Stopped after ${maxMainAdvances} publish retries.`
            : `Push rejected. ${status} ${result.stderr}`.trim();
          rejection = failure(ended);
        }
      }
      accepted = result.exitCode === 0 || /^[ =*]\t/.test(status ?? "");
      detail = [status, result.stderr].filter(Boolean).join("\n");
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    if (rejection) {
      await release(false);
      return rejection;
    }
    if (!accepted) {
      let reconciled = false;
      try {
        accepted = await reconcile(sha);
        reconciled = true;
      } catch (error) {
        detail = [detail, String(error)].filter(Boolean).join("\n");
        queue.block(
          `Publishing is paused because the runner could not reconcile the push of ${sha}. Check origin/main and restart the runner.`,
        );
      }
      if (!accepted && reconciled) {
        await release(false);
        ended =
          `Origin/main does not contain ${sha} after the push. ${detail}`.trim();
        return failure(ended);
      }
    }
    ended = "The runner is already tracking this run's deployment.";
    try {
      await options.trackPush(sha, summary, accepted, detail);
    } finally {
      await release(true);
    }
    return accepted
      ? success(`Published ${sha}. The runner is tracking deployment.`)
      : failure(
          `Push acceptance is uncertain for ${sha}. The runner is tracking deployment.\n${detail}`,
        );
  };

  return {
    async dispatch(command: string, summary?: string) {
      if (ended) return failure(ended);
      if (signal.aborted)
        return failure(
          signal.reason instanceof Error
            ? signal.reason.message
            : "The task runner session has ended.",
        );
      if (active) return failure("Another workflow command is running.");
      const operation =
        command === "fetch"
          ? fetchMain
          : command === "verify"
            ? verify
            : command === "publish"
              ? () => publish(summary)
              : undefined;
      if (!operation) return failure("Unknown workflow command.");
      active = operation().catch((error: unknown) =>
        failure(error instanceof Error ? error.message : String(error)),
      );
      try {
        const result = await active;
        if (signal.aborted && !ended)
          return failure(
            signal.reason instanceof Error
              ? signal.reason.message
              : "The task runner session has ended.",
          );
        return result;
      } finally {
        active = undefined;
        if (ended || signal.aborted) releaseSlot();
      }
    },
    async close() {
      stopped.abort(new Error("The task runner session has ended."));
      await active;
      releaseSlot();
    },
  };
}

export async function withWorkflowServer<T>(
  workflow: ReturnType<typeof createWorkflow>,
  use: (env: Record<string, string>) => Promise<T>,
) {
  const session = crypto.randomUUID();
  let accepting = true;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 8_000,
    idleTimeout: 0,
    async fetch(request) {
      if (
        request.method !== "POST" ||
        request.headers.get("authorization") !== `Bearer ${session}`
      )
        return new Response(null, { status: 404 });
      const command = new URL(request.url).pathname.slice(1);
      const summary = (await request.text()).trim();
      if (!accepting)
        return Response.json(failure("The task runner session has ended."));
      if (summary.length > 2_000 || (summary && command !== "publish"))
        return Response.json(
          failure("Only Publish accepts a summary, up to 2,000 characters."),
        );
      return Response.json(
        await workflow.dispatch(command, summary || undefined),
      );
    },
  });
  try {
    return await use({
      ORUMAI_WORKFLOW_URL: server.url.href,
      ORUMAI_WORKFLOW_SESSION: session,
    });
  } finally {
    // Stop accepting commands before waiting for a request that outlived Codex.
    accepting = false;
    const closed = server.stop(true);
    await workflow.close();
    await closed;
  }
}
