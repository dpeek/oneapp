import { Schema } from "effect";
import { setTimeout } from "node:timers/promises";

export const GitSha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
const MainRef = Schema.Struct({ object: Schema.Struct({ sha: GitSha }) });
const Comparison = Schema.Struct({ status: Schema.String });
const CheckRuns = Schema.Struct({
  check_runs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      head_sha: GitSha,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      details_url: Schema.NullOr(Schema.String),
      check_suite: Schema.Struct({ id: Schema.Int }),
      app: Schema.NullOr(Schema.Struct({ slug: Schema.String })),
    }),
  ),
});
const CheckSuite = Schema.Struct({ head_branch: Schema.NullOr(Schema.String) });
const checkName = "Workers Builds: oneapp-web-production";

export function githubRepository(remote: string) {
  const repo = remote.match(
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/i,
  )?.[1];
  if (!repo) throw new Error("The task runner requires a github.com origin.");
  return repo.toLowerCase();
}

export type ProductionDeployment = {
  readonly sha: string;
  readonly buildUrl: string | null;
  readonly conclusion: string | null;
};

export function productionChecks(repository: string, signal: AbortSignal) {
  const request = async <A>(
    schema: Schema.Decoder<A>,
    endpoint: string,
    allowMissing = false,
  ) => {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    timeout.throwIfAborted();
    const child = Bun.spawn(
      [
        "gh",
        "api",
        "--hostname",
        "github.com",
        `repos/${repository}/${endpoint}`,
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        signal: timeout,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      },
    );
    const [exit, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    timeout.throwIfAborted();
    if (exit !== 0) {
      if (allowMissing && error.includes("(HTTP 404)")) return;
      throw new Error(
        error.trim() || "GitHub did not return deployment status.",
      );
    }
    return Schema.decodeUnknownSync(schema)(JSON.parse(output));
  };

  // Share the production branch tip and check results across this polling pass.
  let main: Promise<string> | undefined;
  const checks = new Map<string, Promise<ProductionDeployment | undefined>>();
  const check = (sha: string) => {
    const cached = checks.get(sha);
    if (cached) return cached;
    const result = request(
      CheckRuns,
      `commits/${sha}/check-runs?filter=all&per_page=100&check_name=${encodeURIComponent(checkName)}`,
      true,
    ).then(async (response) => {
      let completed: ProductionDeployment | undefined;
      for (const run of response?.check_runs ?? []) {
        if (
          run.name !== checkName ||
          run.head_sha !== sha ||
          run.app?.slug !== "cloudflare-workers-and-pages"
        )
          continue;
        const suite = await request(
          CheckSuite,
          `check-suites/${run.check_suite.id}`,
        );
        if (suite?.head_branch === "main") {
          const deployment = {
            sha,
            buildUrl: run.details_url,
            conclusion: run.status === "completed" ? run.conclusion : null,
          };
          if (!deployment.conclusion) return deployment;
          completed ??= deployment;
        }
      }
      return completed;
    });
    checks.set(sha, result);
    return result;
  };

  const deployed = async (
    sha: string,
  ): Promise<ProductionDeployment | undefined> => {
    main ??= request(MainRef, "git/ref/heads/main").then((ref) => {
      if (!ref) throw new Error("GitHub did not return the production branch.");
      return ref.object.sha;
    });
    const head = await main;
    if (head === sha) return check(sha);

    const comparison = await request(
      Comparison,
      `compare/${sha}...${head}?per_page=1`,
      true,
    );
    if (comparison?.status !== "ahead") return;

    const ownCheck = await check(sha);
    if (ownCheck?.conclusion === "success") return ownCheck;
    return (await check(head)) ?? ownCheck;
  };
  return { deployed, exact: check };
}

export async function waitForProduction(
  repository: string,
  sha: string,
  signal: AbortSignal,
) {
  // Alchemy's production state is shared. Wait for the exact parent build
  // to finish before triggering another, while allowing Verify to run ahead.
  while (!signal.aborted) {
    const production = await productionChecks(repository, signal).exact(sha);
    if (production?.conclusion) return;
    await setTimeout(10_000, undefined, { signal });
  }
  signal.throwIfAborted();
}
