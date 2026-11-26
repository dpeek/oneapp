import type { D1Database } from "@cloudflare/workers-types";
import {
  taskRunLeaseMs,
  type TaskRunClaim,
  type TaskRunOutcome,
  type TaskRunUpdate,
} from "../task-run-contract.ts";
import { claimed } from "./items-store.ts";
import { incrementTaskVersion } from "./tasks-store.ts";

export const claimTaskRun = async (
  db: D1Database,
  account: string,
  { taskId, revision, runId }: typeof TaskRunClaim.Type,
  now: number,
) => {
  const claimRevision = crypto.randomUUID();
  const [, , , , run] = await db.batch<{ revision: string }>([
    db
      .prepare(
        `UPDATE items SET revision = ?4, updated_at = ?5
       WHERE account_id = ?1 AND id = ?2 AND revision = ?3 AND kind = 'task'
         AND EXISTS (SELECT 1 FROM tasks
           WHERE account_id = ?1 AND item_id = ?2 AND status = 'not-started')
         AND EXISTS (SELECT 1 FROM item_tags it JOIN tags tag
           ON tag.account_id = it.account_id AND tag.id = it.tag_id
           WHERE it.account_id = ?1 AND it.item_id = ?2 AND tag.name_key = 'ready')
         AND NOT EXISTS (SELECT 1 FROM task_runs
           WHERE account_id = ?1 AND task_id = ?2 AND id = ?6)`,
      )
      .bind(account, taskId, revision, claimRevision, now, runId),
    db
      .prepare(
        `UPDATE tasks SET status = 'in-progress'
       WHERE account_id = ?1 AND item_id = ?2 AND ${claimed}`,
      )
      .bind(account, taskId, claimRevision),
    db
      .prepare(
        `INSERT INTO task_runs (
         account_id, task_id, id, claim_revision, phase, started_at, updated_at, expires_at
       ) SELECT ?1, ?2, ?4, ?3, 'setup', ?5, ?5, ?6 WHERE ${claimed}
       ON CONFLICT (account_id, task_id) DO UPDATE SET
         id = excluded.id, claim_revision = excluded.claim_revision, phase = excluded.phase,
         started_at = excluded.started_at, updated_at = excluded.updated_at,
         expires_at = excluded.expires_at, finished_at = NULL, outcome = NULL,
         summary = NULL, reason = NULL, deployment_url = NULL`,
      )
      .bind(account, taskId, claimRevision, runId, now, now + taskRunLeaseMs),
    incrementTaskVersion(db, "changes() = 1").bind(account),
    db
      .prepare(
        `SELECT r.claim_revision AS revision FROM task_runs r JOIN items i
         ON i.account_id = r.account_id AND i.id = r.task_id
       WHERE r.account_id = ?1 AND r.task_id = ?2 AND r.id = ?3
         AND i.revision = r.claim_revision AND r.phase = 'setup'`,
      )
      .bind(account, taskId, runId),
  ]);
  return run!.results[0]?.revision ?? null;
};

const previousPhase = {
  implementation: "setup",
  checks: "implementation",
  deployment: "checks",
} as const;
const outcomePhase = {
  "setup-failed": "setup",
  "implementation-failed": "implementation",
  "checks-failed": "checks",
  "deployment-failed": "deployment",
  deployed: "deployment",
} satisfies Record<typeof TaskRunOutcome.Type, string>;

export const updateTaskRun = async (
  db: D1Database,
  account: string,
  taskId: string,
  runId: string,
  update: TaskRunUpdate,
  now: number,
) => {
  const match = "account_id = ?1 AND task_id = ?2 AND id = ?3";
  const taskIsCompleted = `EXISTS (SELECT 1 FROM tasks
    WHERE account_id = ?1 AND item_id = ?2 AND status = 'completed')`;
  if (update.phase !== "finished") {
    const phase =
      update.phase === "heartbeat" ? update.activePhase : update.phase;
    const from =
      update.phase === "heartbeat" ? phase : previousPhase[update.phase];
    const deployment =
      update.phase === "heartbeat" && phase === "deployment" ? update : null;
    const [updated] = await db.batch([
      db
        .prepare(
          `UPDATE task_runs SET phase = ?4, updated_at = MAX(updated_at, ?5),
           expires_at = MAX(expires_at, ?6),
           summary = COALESCE(?7, summary), deployment_url = COALESCE(?8, deployment_url),
           reason = COALESCE(?9, reason)
         WHERE ${match} AND phase IN (?10, ?4)`,
        )
        .bind(
          account,
          taskId,
          runId,
          phase,
          now,
          now + taskRunLeaseMs,
          update.phase === "checks" ? update.summary : null,
          deployment?.deploymentUrl ?? null,
          deployment?.reason ?? null,
          from,
        ),
      incrementTaskVersion(db, "changes() = 1").bind(account),
    ]);
    return updated!.meta.changes === 1 ? "updated" : "stale";
  }

  // A deployed run can be reported after a user edit, but only the original
  // claim revision can advance the task status.
  const revision = crypto.randomUUID();
  const complete =
    update.outcome === "deployed"
      ? [
          db
            .prepare(
              `UPDATE items SET revision = ?4, updated_at = ?5
       WHERE account_id = ?1 AND id = ?2
         AND revision = (SELECT claim_revision FROM task_runs
           WHERE ${match} AND phase = 'deployment')
         AND EXISTS (SELECT 1 FROM tasks
           WHERE account_id = ?1 AND item_id = ?2 AND status = 'in-progress')`,
            )
            .bind(account, taskId, runId, revision, now),
          db
            .prepare(
              `UPDATE tasks SET status = 'completed'
       WHERE account_id = ?1 AND item_id = ?2 AND ${claimed}`,
            )
            .bind(account, taskId, revision),
        ]
      : [];
  const results = await db.batch<{ reason: string | null }>([
    ...complete,
    db
      .prepare(
        `UPDATE task_runs SET phase = 'finished', updated_at = ?4, expires_at = NULL,
         finished_at = ?4, outcome = ?5, deployment_url = COALESCE(?6, deployment_url),
         summary = COALESCE(?9, summary),
         reason = CASE
           WHEN ?5 = 'deployed' AND NOT ${taskIsCompleted} THEN 'The task changed after it was claimed.'
           WHEN ?5 = 'deployment-failed' THEN COALESCE(?7, reason, 'No successful production deployment was confirmed.')
           ELSE ?7 END
       WHERE ${match} AND phase = ?8`,
      )
      .bind(
        account,
        taskId,
        runId,
        now,
        update.outcome,
        update.deploymentUrl ?? null,
        update.reason ?? null,
        outcomePhase[update.outcome],
        update.summary ?? null,
      ),
    incrementTaskVersion(db, "changes() = 1").bind(account),
    db
      .prepare(`SELECT reason FROM task_runs WHERE ${match} AND outcome = ?4`)
      .bind(account, taskId, runId, update.outcome),
  ]);
  const row = results.at(-1)!.results[0];
  if (!row) return "stale";
  return update.outcome === "deployed" && row.reason
    ? "completion-skipped"
    : "updated";
};
