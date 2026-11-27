import { expect, it } from "@effect/vitest";
import { buildForCommit } from "./cloudflare.ts";

const sha = "a".repeat(40);
const build = {
  build_uuid: "production-build",
  created_on: "2026-11-27T02:20:39.392Z",
  status: "stopped",
  build_outcome: "success",
  build_trigger_metadata: { branch: "main", commit_hash: sha },
};

it("matches the exact commit on main and excludes preview builds", () => {
  const retries = [
    build,
    {
      ...build,
      created_on: "2026-11-27T02:22:00.000Z",
      status: "running",
      build_trigger_metadata: { branch: "preview", commit_hash: sha },
    },
    {
      ...build,
      created_on: "2026-11-27T02:23:00.000Z",
      status: "running",
      pull_request: { number: 1 },
    },
  ];
  expect(buildForCommit(retries, sha, "account")).toEqual({
    sha,
    buildUrl:
      "https://dash.cloudflare.com/account/workers/services/view/oneapp-web-production/production/builds/production-build",
    conclusion: "success",
  });
  expect(buildForCommit(retries, "b".repeat(40))).toBeUndefined();
});

it("uses the latest production retry and waits for it to stop", () => {
  const retry = {
    ...build,
    build_uuid: "retry",
    created_on: "2026-11-27T02:23:00.000Z",
    status: "running",
    build_outcome: null,
  };
  expect(buildForCommit([build, retry], sha)).toMatchObject({
    buildUrl: expect.stringContaining("/builds/retry"),
    conclusion: null,
  });
  expect(
    buildForCommit(
      [{ ...retry, status: "stopped", build_outcome: "fail" }, build],
      sha,
    )?.conclusion,
  ).toBe("fail");
});
