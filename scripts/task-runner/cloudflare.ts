import { Schema } from "effect";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { GitSha } from "./git.ts";
import { captureCommand, commandEnv, gitEnv } from "./workflow.ts";

const workerName = "oneapp-web-production";
const mainRef = "refs/heads/main";
const pageSize = 100;

const Workers = Schema.Array(
  Schema.Struct({ script_name: Schema.String, id: Schema.String }),
);
const Build = Schema.Struct({
  build_uuid: Schema.String,
  created_on: Schema.String,
  status: Schema.String,
  build_outcome: Schema.optionalKey(Schema.NullOr(Schema.String)),
  pull_request: Schema.optionalKey(Schema.Unknown),
  build_trigger_metadata: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
        commit_hash: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
const decodeBuilds = Schema.decodeUnknownSync(Schema.Array(Build));

export type ProductionDeployment = {
  readonly sha: string;
  readonly buildUrl: string | null;
  readonly conclusion: string | null;
};

export function buildForCommit(
  builds: readonly (typeof Build.Type)[],
  sha: string,
  accountId?: string,
): ProductionDeployment | undefined {
  const latest = builds
    .filter(
      (build) =>
        build.build_trigger_metadata?.branch === "main" &&
        build.build_trigger_metadata.commit_hash === sha &&
        build.pull_request == null,
    )
    .sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0];
  if (!latest) return;
  const path = `/workers/services/view/${workerName}/production/builds/${encodeURIComponent(latest.build_uuid)}`;
  return {
    sha,
    buildUrl: accountId
      ? `https://dash.cloudflare.com/${encodeURIComponent(accountId)}${path}`
      : `https://dash.cloudflare.com/?to=/:account${path}`,
    conclusion:
      latest.status === "stopped" ? (latest.build_outcome ?? null) : null,
  };
}

export async function cloudflareBuilds(source: string, signal: AbortSignal) {
  const cf = Bun.which("cf", { PATH: join(source, "node_modules", ".bin") });
  if (!cf)
    throw new Error("Run bun install to install the project's Cloudflare CLI.");
  if (!Bun.which("node"))
    throw new Error("Install Node.js 22 or newer to run the Cloudflare CLI.");

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const profile = process.env.CLOUDFLARE_AUTH_PROFILE;
  const request = async (args: string[], signal: AbortSignal) => {
    const result = await captureCommand(
      [cf, "--quiet", ...(profile ? ["--profile", profile] : []), ...args],
      source,
      AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      process.env,
    );
    if (result.exitCode !== 0)
      throw new Error(
        result.stderr || `Cloudflare CLI exited with code ${result.exitCode}.`,
      );
    return JSON.parse(result.stdout);
  };

  let workerTag = process.env.ORUMAI_CLOUDFLARE_WORKER_TAG;
  if (!workerTag) {
    const workers = Schema.decodeUnknownSync(Workers)(
      await request(
        ["workers", "scripts", "search", "--name", workerName],
        signal,
      ),
    );
    workerTag = workers.find((worker) => worker.script_name === workerName)?.id;
    if (!workerTag)
      throw new Error(`Cloudflare could not find the ${workerName} Worker.`);
  }
  const tag = workerTag;

  function checks(signal: AbortSignal) {
    const pages = new Map<number, Promise<readonly (typeof Build.Type)[]>>();
    const list = (page: number) => {
      let result = pages.get(page);
      if (!result) {
        result = request(
          [
            "builds",
            "list",
            "--external-script-id",
            tag,
            "--per-page",
            String(pageSize),
            "--page",
            String(page),
          ],
          signal,
        ).then(decodeBuilds);
        pages.set(page, result);
      }
      return result;
    };
    const exact = async (sha: string) => {
      for (let page = 1; ; page++) {
        const builds = await list(page);
        const deployment = buildForCommit(builds, sha, accountId);
        if (deployment || builds.length < pageSize) return deployment;
      }
    };

    const git = (args: string[]) =>
      captureCommand(
        ["git", ...args],
        source,
        AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        { ...commandEnv, ...gitEnv },
      );
    let main: Promise<string> | undefined;
    let mainObjects: Promise<void> | undefined;
    const readMain = async () => {
      const result = await git(["ls-remote", "--exit-code", "origin", mainRef]);
      if (result.exitCode !== 0)
        throw new Error(result.stderr || "Git did not return origin/main.");
      return Schema.decodeUnknownSync(GitSha)(result.stdout.split("\t")[0]);
    };
    const fetchMainObjects = async (head: string) => {
      if ((await git(["cat-file", "-e", `${head}^{commit}`])).exitCode === 0)
        return;
      // Download the objects needed for ancestry without updating local refs.
      const result = await git([
        "fetch",
        "--no-tags",
        "--refmap=",
        "--no-write-fetch-head",
        "--no-auto-maintenance",
        "origin",
        head,
      ]);
      if (result.exitCode !== 0)
        throw new Error(result.stderr || "Git could not fetch origin/main.");
    };
    const deployed = async (sha: string) => {
      const head = await (main ??= readMain());
      const own = await exact(sha);
      if (head === sha) return own;
      const deployment =
        own?.conclusion === "success" ? own : ((await exact(head)) ?? own);
      if (!deployment) return;

      await (mainObjects ??= fetchMainObjects(head));
      if ((await git(["cat-file", "-e", `${sha}^{commit}`])).exitCode !== 0)
        return;
      const ancestry = await git(["merge-base", "--is-ancestor", sha, head]);
      if (ancestry.exitCode === 0) return deployment;
      if (ancestry.exitCode !== 1)
        throw new Error(
          ancestry.stderr || "Git could not verify deployment ancestry.",
        );
    };
    return { exact, deployed };
  }

  return {
    checks,
    async waitForProduction(sha: string, signal: AbortSignal) {
      // Production builds share Alchemy state. Let the exact parent build
      // finish before triggering another, while allowing Verify to run ahead.
      while (!signal.aborted) {
        if ((await checks(signal).exact(sha))?.conclusion) return;
        await setTimeout(10_000, undefined, { signal });
      }
      signal.throwIfAborted();
    },
  };
}
