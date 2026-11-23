import { DurableObject } from "cloudflare:workers";
import type { WorkerEnv } from "../alchemy.run.ts";
import {
  ingestRawMail,
  type MailImportMetadata,
} from "../apps/web/src/server/mail-import.ts";
import {
  completeImportedConversations,
  type CompletionRequest,
} from "../apps/web/src/server/mail-import-completion.ts";

export class MailSample extends DurableObject<
  Pick<WorkerEnv, "DB" | "INBOX_MESSAGES" | "SENT_MESSAGES">
> {
  async ready() {
    await this.env.DB.prepare(
      "SELECT source_id FROM mail_imports LIMIT 1",
    ).all();
    return true;
  }

  async completeImport(request: CompletionRequest) {
    return completeImportedConversations(this.env.DB, request);
  }

  async completed(source: MailImportMetadata["source"]) {
    const row = await this.receipt(source);
    return row?.completedAt != null ? row.id : null;
  }

  async receipt(source: MailImportMetadata["source"]) {
    const key = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify([
            source.account,
            source.mailbox,
            source.uidValidity,
            source.uid,
          ]),
        ),
      ),
    ).toHex();
    return this.env.DB.prepare(
      `SELECT message_id AS id, sha256, metadata, completed_at AS completedAt
      FROM mail_imports WHERE source_id = ?`,
    )
      .bind(key)
      .first<{
        id: string;
        sha256: string;
        metadata: string;
        completedAt: number | null;
      }>();
  }

  async ingest(metadata: MailImportMetadata, raw: Uint8Array<ArrayBuffer>) {
    try {
      return await ingestRawMail(this.env, metadata, raw);
    } catch {
      return { status: "failed" as const };
    }
  }

  async totals() {
    return this.env.DB.prepare(
      `SELECT folder, count(*) AS messages, sum(unread) AS unread
      FROM mail_index_messages WHERE deleted = 0 GROUP BY folder`,
    ).all();
  }
}
