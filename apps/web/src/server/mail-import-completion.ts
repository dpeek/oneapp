import type { D1Database } from "@cloudflare/workers-types";

export const importCompletionPolicy = (asOf: string) => {
  const timestamp = Date.parse(asOf);
  if (!Number.isSafeInteger(timestamp) || timestamp < 30 * 86_400_000)
    throw new Error("Invalid import policy date");
  return {
    version: 1 as const,
    inactiveDays: 30 as const,
    asOf: new Date(timestamp).toISOString(),
    cutoff: timestamp - 30 * 86_400_000,
  };
};
export type CompletionRequest = {
  id: string;
  asOf: string;
  sourceIds: readonly string[];
};
type Decision = {
  threadId: string;
  latest: number;
  reason:
    | "already-complete"
    | "outside-import"
    | "unread"
    | "flagged"
    | "recent"
    | "inactive-read-unflagged";
  messageIds: string[];
};

// Classification runs inside the same D1 batch as the archive updates and
// completion receipt. A retry returns the original decisions without writing
// conversation state again, including after subsequent user edits or new mail.
export const completeImportedConversations = async (
  db: D1Database,
  request: CompletionRequest,
) => {
  const policy = importCompletionPolicy(request.asOf);
  const sourceIds = [...new Set(request.sourceIds)].sort();
  if (!request.id || sourceIds.some((id) => !/^[a-f0-9]{64}$/u.test(id)))
    throw new Error("Invalid completion selection");
  const selection = JSON.stringify(sourceIds);
  const configuration = JSON.stringify({ ...policy, sourceIds });
  const existing = await db
    .prepare("SELECT policy FROM mail_import_completions WHERE id = ?")
    .bind(request.id)
    .first<{ policy: string }>();
  if (existing && existing.policy !== configuration)
    throw new Error(
      "Import completion policy changed; use a fresh destination",
    );
  const ready = await db
    .prepare(
      `SELECT count(*) AS count FROM mail_imports i
    JOIN mail_index_messages m ON m.id = i.message_id
    WHERE i.source_id IN (SELECT value FROM json_each(?)) AND i.completed_at IS NOT NULL`,
    )
    .bind(selection)
    .first<{ count: number }>();
  if (ready?.count !== sourceIds.length)
    throw new Error(
      "Finish importing every selected message before completing conversations",
    );

  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO mail_import_completions (id, policy, decisions)
      WITH selected AS (SELECT value AS source_id FROM json_each(?1)),
      threads AS (
        SELECT m.thread_id AS threadId, max(m.timestamp) AS latest,
          max(CASE WHEN m.folder = 'inbox' THEN m.unread ELSE 0 END) AS unread,
          max(CASE WHEN EXISTS (SELECT 1 FROM json_each(i.metadata, '$.flags') WHERE value = ?2) THEN 1 ELSE 0 END) AS flagged,
          min(CASE WHEN s.source_id IS NOT NULL AND i.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS whollyImported,
          max(CASE WHEN m.folder = 'inbox' AND m.archived = 0 THEN 1 ELSE 0 END) AS active,
          json_group_array(m.id) FILTER (WHERE m.folder = 'inbox') AS messageIds
        FROM mail_index_messages m
        LEFT JOIN mail_imports i ON i.message_id = m.id
        LEFT JOIN selected s ON s.source_id = i.source_id
        WHERE m.deleted = 0
        GROUP BY m.thread_id
        HAVING max(CASE WHEN s.source_id IS NOT NULL THEN 1 ELSE 0 END) = 1
          AND max(CASE WHEN m.folder = 'inbox' THEN 1 ELSE 0 END) = 1
      )
      SELECT ?3, ?4, json_group_array(json_object(
        'threadId', threadId, 'latest', latest, 'messageIds', json(messageIds),
        'reason', CASE WHEN active = 0 THEN 'already-complete'
          WHEN whollyImported = 0 THEN 'outside-import'
          WHEN unread = 1 THEN 'unread'
          WHEN flagged = 1 THEN 'flagged'
          WHEN latest >= ?5 THEN 'recent'
          ELSE 'inactive-read-unflagged' END)) FROM threads`,
      )
      .bind(selection, "\\Flagged", request.id, configuration, policy.cutoff),
    db
      .prepare(
        `UPDATE mail_index_messages SET archived = 1
      WHERE folder = 'inbox' AND deleted = 0 AND archived = 0 AND id IN (
        SELECT member.value FROM mail_import_completions r,
          json_each(r.decisions) decision, json_each(decision.value, '$.messageIds') member
        WHERE r.id = ?1 AND r.policy = ?2 AND r.completed_at IS NULL
          AND json_extract(decision.value, '$.reason') = 'inactive-read-unflagged'
      )`,
      )
      .bind(request.id, configuration),
    db
      .prepare(
        "UPDATE mail_import_completions SET completed_at = ? WHERE id = ? AND policy = ? AND completed_at IS NULL",
      )
      .bind(Date.now(), request.id, configuration),
  ]);
  const receipt = await db
    .prepare(
      "SELECT policy, decisions, completed_at AS completedAt FROM mail_import_completions WHERE id = ?",
    )
    .bind(request.id)
    .first<{ policy: string; decisions: string; completedAt: number | null }>();
  if (!receipt?.completedAt || receipt.policy !== configuration)
    throw new Error("Could not verify import completion");
  const decisions: Decision[] = JSON.parse(receipt.decisions);
  return {
    policy,
    completedAt: receipt.completedAt,
    completedConversations: decisions.filter(
      (d) => d.reason === "inactive-read-unflagged",
    ).length,
    keptInInbox: decisions.filter(
      (d) =>
        !["already-complete", "inactive-read-unflagged"].includes(d.reason),
    ).length,
    alreadyComplete: decisions.filter((d) => d.reason === "already-complete")
      .length,
    decisions,
  };
};
