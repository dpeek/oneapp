import { Schema } from "effect";

export const GitSha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));

export function githubRepository(remote: string) {
  const repo = remote.match(
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/i,
  )?.[1];
  if (!repo) throw new Error("The task runner requires a github.com origin.");
  return repo.toLowerCase();
}
