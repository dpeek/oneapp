import { ownerId } from "../apps/web/src/server/auth.ts";
import {
  ensureDefaultMailbox,
  requireMailbox,
  scopeMailStore,
  mailboxSql,
} from "../apps/web/src/server/mailbox.ts";
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
  private async store(mailboxId: string) {
    await ensureDefaultMailbox(this.env.DB);
    await requireMailbox(this.env.DB, mailboxId, ownerId);
    return scopeMailStore(this.env, mailboxId);
  }

  async ready(mailboxId: string) {
    const { DB } = await this.store(mailboxId);
    await DB.prepare(
      "SELECT source_id FROM mail_imports WHERE mailbox_id = ? LIMIT 1",
    )
      .bind(mailboxId)
      .all();
    return true;
  }

  async completeImport(mailboxId: string, request: CompletionRequest) {
    return completeImportedConversations(
      (await this.store(mailboxId)).DB,
      request,
    );
  }

  async completed(mailboxId: string, source: MailImportMetadata["source"]) {
    const row = await this.receipt(mailboxId, source);
    return row?.completedAt != null ? row.id : null;
  }

  async receipt(mailboxId: string, source: MailImportMetadata["source"]) {
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
    const { DB } = await this.store(mailboxId);
    return DB.prepare(
      `SELECT message_id AS id, sha256, metadata, completed_at AS completedAt
      FROM mail_imports WHERE mailbox_id = ${mailboxSql(DB)} AND source_id = ?`,
    )
      .bind(key)
      .first<{
        id: string;
        sha256: string;
        metadata: string;
        completedAt: number | null;
      }>();
  }

  async ingest(
    mailboxId: string,
    metadata: MailImportMetadata,
    raw: Uint8Array<ArrayBuffer>,
  ) {
    try {
      return await ingestRawMail(await this.store(mailboxId), metadata, raw);
    } catch {
      return { status: "failed" as const };
    }
  }

  async totals(mailboxId: string) {
    const { DB } = await this.store(mailboxId);
    return DB.prepare(
      `SELECT folder, count(*) AS messages, sum(unread) AS unread
      FROM mail_index_messages WHERE mailbox_id = ${mailboxSql(DB)} AND deleted = 0 GROUP BY folder`,
    ).all();
  }
}
