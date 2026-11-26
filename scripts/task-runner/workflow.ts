import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { GitSha } from "./github.ts";
import { Schema } from "effect";
import { stopProcessGroup } from "./processes.ts";
import type { WorkflowResult } from "./workflow-client.ts";

const mainRef = "refs/heads/main";
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
    signal,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
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
  const { repo, mirror, run, sandbox, env, signal } = options;
  const localGitEnv = {
    ...commandEnv,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const logPath = join(run, "verify.log");
  const verified = new Set<string>();
  let pendingActivity: { sha: string; result: WorkflowResult } | undefined;
  let published = false;
  let active: Promise<WorkflowResult> | undefined;

  const git = async (args: string[], cwd = mirror) =>
    requireSuccess(
      `git ${args[0]}`,
      await captureCommand(["git", ...args], cwd, signal, localGitEnv),
    );
  const remoteGit = (args: string[]) =>
    captureCommand(["git", ...args], mirror, signal, {
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

  const fetchMain = async () => {
    const result = await remoteGit([
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "origin",
      `${mainRef}:${mainRef}`,
    ]);
    if (result.exitCode !== 0)
      return failure(
        `Fetch failed (exit ${result.exitCode}). ${result.stderr}`,
        result.exitCode,
      );
    return success(
      `Fetched main at ${await git(["rev-parse", mainRef])}. Run git fetch origin in the checkout.`,
    );
  };

  const checkSnapshot = async (sha: string) => {
    // Copy the commit without credentials. A separate checkout keeps edits
    // during verification from affecting the suite.
    const candidate = `refs/orumai/candidates/${sha}`;
    await git([
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      repo,
      `${sha}:${candidate}`,
    ]);
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
              signal,
              env,
              detached: true,
              stdin: "ignore",
              stdout: log.fd,
              stderr: log.fd,
            },
          );
          const exitCode = await child.exited.finally(() =>
            stopProcessGroup(child),
          );
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
      verified.add(sha);
      return success(`Verified ${sha}.`);
    } finally {
      await rm(snapshot, { recursive: true, force: true });
    }
  };

  const verify = async () => {
    const sha = await cleanHead();
    if (pendingActivity) {
      await options.working(pendingActivity.sha, pendingActivity.result);
      pendingActivity = undefined;
    }
    if (verified.has(sha)) return success(`Verified ${sha} (cached).`);
    await options.checking(sha);
    const result = await checkSnapshot(sha).catch((error: unknown) =>
      failure(error instanceof Error ? error.message : String(error)),
    );
    pendingActivity = { sha, result };
    await options.working(sha, result);
    pendingActivity = undefined;
    return result;
  };

  const publish = async (summary: string | undefined) => {
    const sha = await cleanHead();
    if (!verified.has(sha))
      return failure(
        `HEAD ${sha} has no successful verification. Run Verify before publishing.`,
      );
    const upstream = await git(["rev-parse", mainRef]);
    if (sha === upstream)
      return failure(
        "HEAD matches main. Commit the task changes before publishing.",
      );
    const ancestry = await captureCommand(
      ["git", "merge-base", "--is-ancestor", upstream, sha],
      mirror,
      signal,
    );
    if (ancestry.exitCode === 1)
      return failure(
        "Main has advanced. Fetch, rebase onto origin/main, and verify again.",
      );
    requireSuccess("git merge-base", ancestry);

    if ((await cleanHead()) !== sha)
      return failure(
        "HEAD changed before publishing. Verify the current commit.",
      );
    const release = await options.preparePush(sha, summary);
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
        const rejected =
          /\((fetch first|non-fast-forward|failed to update ref)\)/.test(
            status,
          );
        rejection = failure(
          rejected
            ? `Push rejected. Fetch, rebase onto origin/main, and verify again.\n${status}`
            : `Push rejected.\n${status}${result.stderr ? `\n${result.stderr}` : ""}`,
          result.exitCode || 1,
        );
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
    published = true;
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
      if (published)
        return failure("The runner is already tracking this run's deployment.");
      if (signal.aborted) return failure("The task runner session has ended.");
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
        return await active;
      } finally {
        active = undefined;
      }
    },
    async drain() {
      await active;
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
    await workflow.drain();
    await closed;
  }
}
