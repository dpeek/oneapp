import type { D1Database } from "@cloudflare/workers-types";
import {
  taskRunLeaseMs,
  type TaskRunClaim,
  type TaskRunOutcome,
  type TaskRunUpdate,
} from "../task-run-contract.ts";
import type { WorkspaceActor } from "../tasks-contract.ts";
import { claimed } from "./items-store.ts";
import { incrementTaskVersion } from "./tasks-store.ts";

export const claimTaskRun = async (
  db: D1Database,
  { accountId: account, kind }: WorkspaceActor,
  { taskId, revision, runId, source = "ready-tag" }: typeof TaskRunClaim.Type,
  now: number,
) => {
  if (kind !== "oru") return null;
  const claimRevision = crypto.randomUUID();
  // Persist the request revision for exact retries and for failure handoff.
  const assignmentRequestRevision = source === "assignment" ? revision : null;
  const [, , , , run] = await db.batch<{ revision: string }>([
    db
      .prepare(
        `UPDATE items SET revision = ?4, updated_at = ?5
       WHERE account_id = ?1 AND id = ?2 AND revision = ?3 AND kind = 'task'
         AND EXISTS (SELECT 1 FROM tasks
           WHERE account_id = ?1 AND item_id = ?2 AND status = 'not-started'
             AND (?7 IS NULL OR assignee = 'oru'))
         AND (?7 IS NOT NULL OR EXISTS (SELECT 1 FROM item_tags it JOIN tags tag
           ON tag.account_id = it.account_id AND tag.id = it.tag_id
           WHERE it.account_id = ?1 AND it.item_id = ?2 AND tag.name_key = 'ready'))
         AND NOT EXISTS (SELECT 1 FROM task_runs
           WHERE account_id = ?1 AND task_id = ?2 AND id = ?6)`,
      )
      .bind(
        account,
        taskId,
        revision,
        claimRevision,
        now,
        runId,
        assignmentRequestRevision,
      ),
    db
      .prepare(
        `UPDATE tasks SET status = 'in-progress'
       WHERE account_id = ?1 AND item_id = ?2 AND ${claimed}`,
      )
      .bind(account, taskId, claimRevision),
    db
      .prepare(
        `INSERT INTO task_runs (
         account_id, task_id, id, claim_revision, assignment_request_revision,
         phase, started_at, updated_at, expires_at
       ) SELECT ?1, ?2, ?4, ?3, ?7, 'setup', ?5, ?5, ?6 WHERE ${claimed}
       ON CONFLICT (account_id, task_id) DO UPDATE SET
         id = excluded.id, claim_revision = excluded.claim_revision,
         assignment_request_revision = excluded.assignment_request_revision,
         phase = excluded.phase,
         started_at = excluded.started_at, updated_at = excluded.updated_at,
         expires_at = excluded.expires_at, finished_at = NULL, outcome = NULL,
         summary = NULL, reason = NULL, deployment_url = NULL`,
      )
      .bind(
        account,
        taskId,
        claimRevision,
        runId,
        now,
        now + taskRunLeaseMs,
        assignmentRequestRevision,
      ),
    incrementTaskVersion(db, "changes() = 1").bind(account),
    db
      .prepare(
        `SELECT r.claim_revision AS revision FROM task_runs r JOIN items i
         ON i.account_id = r.account_id AND i.id = r.task_id
       WHERE r.account_id = ?1 AND r.task_id = ?2 AND r.id = ?3
         AND i.revision = r.claim_revision AND r.phase = 'setup'
         AND r.assignment_request_revision IS ?4`,
      )
      .bind(account, taskId, runId, assignmentRequestRevision),
  ]);
  return run!.results[0]?.revision ?? null;
};

const previousPhase = {
  implementation: ["setup", "checks"],
  checks: ["implementation", null],
  deployment: ["implementation", "checks"],
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
  { accountId: account, kind }: WorkspaceActor,
  taskId: string,
  runId: string,
  update: TaskRunUpdate,
  now: number,
) => {
  if (kind !== "oru") return "stale";
  const match = "account_id = ?1 AND task_id = ?2 AND id = ?3";
  const taskIsCompleted = `EXISTS (SELECT 1 FROM tasks
    WHERE account_id = ?1 AND item_id = ?2 AND status = 'completed')`;
  if (update.phase !== "finished") {
    const phase =
      update.phase === "heartbeat" ? update.activePhase : update.phase;
    const [from, alsoFrom] =
      update.phase === "heartbeat"
        ? [phase, null]
        : previousPhase[update.phase];
    const deployment =
      update.phase === "heartbeat" && phase === "deployment" ? update : null;
    const [updated] = await db.batch([
      db
        .prepare(
          `UPDATE task_runs SET phase = ?4, updated_at = MAX(updated_at, ?5),
           expires_at = MAX(expires_at, ?6),
           summary = COALESCE(?7, summary), deployment_url = COALESCE(?8, deployment_url),
           reason = COALESCE(?9, reason)
         WHERE ${match} AND phase IN (?4, ?10, ?11)`,
        )
        .bind(
          account,
          taskId,
          runId,
          phase,
          now,
          now + taskRunLeaseMs,
          update.phase === "checks" || update.phase === "deployment"
            ? (update.summary ?? null)
            : null,
          deployment?.deploymentUrl ?? null,
          deployment?.reason ?? null,
          from,
          alsoFrom,
        ),
      incrementTaskVersion(db, "changes() = 1").bind(account),
    ]);
    return updated!.meta.changes === 1 ? "updated" : "stale";
  }

  // Record the outcome even after an edit. Task changes require the claim revision.
  const revision = crypto.randomUUID();
  const deployed = update.outcome === "deployed";
  const results = await db.batch<{ reason: string | null }>([
    db
      .prepare(
        `UPDATE items SET revision = ?4, updated_at = ?5
       WHERE account_id = ?1 AND id = ?2
         AND revision = (SELECT claim_revision FROM task_runs
           WHERE ${match} AND phase = ?6 AND (?7 OR assignment_request_revision IS NOT NULL))
         AND EXISTS (SELECT 1 FROM tasks
           WHERE account_id = ?1 AND item_id = ?2 AND status = 'in-progress'
             AND (?7 OR assignee = 'oru'))`,
      )
      .bind(
        account,
        taskId,
        runId,
        revision,
        now,
        outcomePhase[update.outcome],
        Number(deployed),
      ),
    db
      .prepare(
        `UPDATE tasks SET status = CASE WHEN ?4 THEN 'completed' ELSE 'not-started' END,
           assignee = CASE WHEN ?4 THEN assignee ELSE 'owner' END
       WHERE account_id = ?1 AND item_id = ?2 AND ${claimed}`,
      )
      .bind(account, taskId, revision, Number(deployed)),
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
