import { Schema } from "effect";
import { ItemId } from "./items-contract.ts";

export const taskRunHeartbeatMs = 20_000;
export const taskRunLeaseMs = 90_000;
const activePhases = [
  "setup",
  "implementation",
  "waiting-to-publish",
  "checks",
  "deployment",
] as const;
export const taskRunPhases = [...activePhases, "finished"] as const;
const outcomes = [
  "deployed",
  "setup-failed",
  "implementation-failed",
  "publish-failed",
  "checks-failed",
  "deployment-failed",
] as const;
export const TaskRunOutcome = Schema.Literals(outcomes);
export const TaskRunSummary = Schema.String.check(Schema.isMaxLength(2_000));
const DeploymentUrl = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter(
    (url) => URL.canParse(url) && new URL(url).protocol === "https:",
  ),
);

export const TaskRun = Schema.Struct({
  id: ItemId,
  phase: Schema.Literals(taskRunPhases),
  startedAt: Schema.Number,
  updatedAt: Schema.Number,
  expiresAt: Schema.NullOr(Schema.Number),
  finishedAt: Schema.NullOr(Schema.Number),
  outcome: Schema.NullOr(TaskRunOutcome),
  summary: Schema.NullOr(TaskRunSummary),
  reason: Schema.NullOr(TaskRunSummary),
  deploymentUrl: Schema.NullOr(DeploymentUrl),
});
export type TaskRun = typeof TaskRun.Type;

export const taskRunClaimSources = ["ready-tag", "assignment"] as const;
export const TaskRunClaim = Schema.Struct({
  taskId: ItemId,
  revision: ItemId,
  runId: ItemId,
  source: Schema.optionalKey(Schema.Literals(taskRunClaimSources)),
});
export const TaskRunUpdate = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("implementation") }),
  Schema.Struct({ phase: Schema.Literal("waiting-to-publish") }),
  Schema.Struct({
    phase: Schema.Literal("checks"),
    summary: Schema.optionalKey(TaskRunSummary),
  }),
  Schema.Struct({
    phase: Schema.Literal("deployment"),
    summary: Schema.optionalKey(TaskRunSummary),
  }),
  Schema.Struct({
    phase: Schema.Literal("heartbeat"),
    activePhase: Schema.Literals(activePhases),
    deploymentUrl: Schema.optional(DeploymentUrl),
    reason: Schema.optional(TaskRunSummary),
  }),
  Schema.Struct({
    phase: Schema.Literal("finished"),
    outcome: TaskRunOutcome,
    summary: Schema.optional(TaskRunSummary),
    reason: Schema.optional(TaskRunSummary),
    deploymentUrl: Schema.optional(DeploymentUrl),
  }),
]);
export type TaskRunUpdate = typeof TaskRunUpdate.Type;

export const isTaskRunInterrupted = (run: TaskRun, now: number) =>
  run.expiresAt !== null && run.expiresAt <= now;
