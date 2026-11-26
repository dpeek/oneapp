import { Data, Schema } from "effect";
import { MailImportPlan, MailImportEntry } from "@orumai/core/mail-import";
import { mailboxSql, type MailDatabase } from "./mailbox.ts";
import {
  completeImportedConversations,
  importCompletionPolicy,
} from "./mail-import-completion.ts";

export class MailImportError extends Data.TaggedError("MailImportError")<{
  status: number;
  message: string;
}> {}
export const importHash = async (value: Uint8Array<ArrayBuffer> | string) =>
  new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    ),
  ).toHex();

export const startMailImport = async (
  db: MailDatabase,
  input: MailImportPlan,
) => {
  try {
    importCompletionPolicy(input.asOf);
  } catch {
    throw new MailImportError({
      status: 400,
      message: "Invalid snapshot date",
    });
  }
  const ids = new Set<string>();
  for (const entry of input.entries) {
    const source = entry.metadata.source;
    const hash = await importHash(
      JSON.stringify([
        source.account,
        source.mailbox,
        source.uidValidity,
        source.uid,
      ]),
    );
    if (
      hash !== entry.sourceId ||
      source.account !== input.sourceAccount ||
      ids.has(hash) ||
      (entry.metadata.folder === "sent" && entry.metadata.archived)
    )
      throw new MailImportError({
        status: 400,
        message: "Invalid or duplicate import source",
      });
    ids.add(hash);
  }
  const plan = {
    ...input,
    entries: [...input.entries].sort((a, b) =>
      a.sourceId.localeCompare(b.sourceId),
    ),
  };
  const configuration = JSON.stringify(plan);
  await db
    .prepare(
      `INSERT OR IGNORE INTO mail_import_runs (mailbox_id, id, configuration, created_at) VALUES (${mailboxSql(db)}, ?, ?, ?)`,
    )
    .bind(plan.snapshotId, configuration, Date.now())
    .run();
  const existing = await db
    .prepare(
      `SELECT configuration FROM mail_import_runs WHERE mailbox_id = ${mailboxSql(db)} AND id = ?`,
    )
    .bind(plan.snapshotId)
    .first<{ configuration: string }>();
  if (existing?.configuration !== configuration)
    throw new MailImportError({
      status: 409,
      message:
        "This snapshot already has a different import plan in this mailbox",
    });
  return { snapshotId: plan.snapshotId };
};

export const readImportEntry = async (
  db: MailDatabase,
  runId: string,
  sourceId: string,
) => {
  const row = await db
    .prepare(
      `SELECT e.value AS entry FROM mail_import_runs r, json_each(r.configuration, '$.entries') e
    WHERE r.mailbox_id = ${mailboxSql(db)} AND r.id = ? AND json_extract(e.value, '$.sourceId') = ?`,
    )
    .bind(runId, sourceId)
    .first<{ entry: string }>();
  if (!row)
    throw new MailImportError({
      status: 404,
      message: "Import source not found in this mailbox and run",
    });
  return Schema.decodeUnknownSync(Schema.fromJsonString(MailImportEntry))(
    row.entry,
  );
};

export const readImportReceipt = async (
  db: MailDatabase,
  entry: typeof MailImportEntry.Type,
) => {
  const receipt = await db
    .prepare(
      `SELECT message_id AS id, sha256, metadata, completed_at AS completedAt FROM mail_imports WHERE mailbox_id = ${mailboxSql(db)} AND source_id = ?`,
    )
    .bind(entry.sourceId)
    .first<{
      id: string;
      sha256: string;
      metadata: string;
      completedAt: number | null;
    }>();
  if (receipt) {
    const initial = JSON.parse(receipt.metadata);
    // Source flags may have changed since a previous snapshot. Never reset
    // subsequent local read/archive state when reusing a verified receipt.
    if (
      receipt.sha256 !== entry.sha256 ||
      initial.folder !== entry.metadata.folder ||
      initial.archived !== entry.metadata.archived ||
      initial.timestamp !== entry.metadata.timestamp
    )
      throw new MailImportError({
        status: 409,
        message: "This source has a conflicting checksum or import mapping",
      });
  }
  return receipt;
};

export const finishMailImport = async (db: MailDatabase, id: string) => {
  const row = await db
    .prepare(
      `SELECT configuration FROM mail_import_runs WHERE mailbox_id = ${mailboxSql(db)} AND id = ?`,
    )
    .bind(id)
    .first<{ configuration: string }>();
  if (!row)
    throw new MailImportError({ status: 404, message: "Import run not found" });
  const plan = Schema.decodeUnknownSync(Schema.fromJsonString(MailImportPlan))(
    row.configuration,
  );
  const ready = await db
    .prepare(
      `SELECT count(*) AS count FROM json_each(?, '$.entries') e
    JOIN mail_imports i ON i.mailbox_id = ${mailboxSql(db)} AND i.source_id = json_extract(e.value, '$.sourceId')
    WHERE i.completed_at IS NOT NULL AND i.sha256 = json_extract(e.value, '$.sha256')
    AND json_extract(i.metadata, '$.folder') = json_extract(e.value, '$.metadata.folder')
    AND json_extract(i.metadata, '$.archived') = json_extract(e.value, '$.metadata.archived')
    AND json_extract(i.metadata, '$.timestamp') = json_extract(e.value, '$.metadata.timestamp')`,
    )
    .bind(row.configuration)
    .first<{ count: number }>();
  if (ready?.count !== plan.entries.length)
    throw new MailImportError({
      status: 409,
      message:
        "Finish every message in this import plan before completing conversations",
    });
  const { decisions: _decisions, ...result } =
    await completeImportedConversations(db, {
      id: `${id}:${plan.mappingHash}`,
      asOf: plan.asOf,
      sourceIds: plan.entries.map((entry) => entry.sourceId),
    });
  await db
    .prepare(
      `UPDATE mail_import_runs SET completed_at = coalesce(completed_at, ?) WHERE mailbox_id = ${mailboxSql(db)} AND id = ?`,
    )
    .bind(result.completedAt, id)
    .run();
  return result;
};
