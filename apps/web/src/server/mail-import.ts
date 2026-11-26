import { mailboxSql, type MailDatabase } from "./mailbox.ts";
import type { R2Bucket } from "@cloudflare/workers-types";
import { Schema } from "effect";
import { indexMailStatements } from "./mail-index.ts";
import { describeRawMail, parseRawHeaders, rawMailFormat } from "./raw-mail.ts";

import { MailImportMetadata } from "@orumai/core/mail-import";
export { MailImportMetadata } from "@orumai/core/mail-import";

type ImportStore = {
  DB: MailDatabase;
  INBOX_MESSAGES: R2Bucket;
  SENT_MESSAGES: R2Bucket;
};
type Receipt = {
  messageId: string;
  sha256: string;
  metadata: string;
  completedAt: number | null;
};
const decodeMetadata = Schema.decodeUnknownSync(MailImportMetadata);
const hash = async (bytes: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();

// Internal service: HTTP and local adapters validate authorization and limits.
export const ingestRawMail = async (
  store: ImportStore,
  input: unknown,
  raw: Uint8Array<ArrayBuffer>,
) => {
  const metadata = decodeMetadata(input);
  if (!raw.byteLength) throw new Error("Cannot import an empty message");
  const { account, mailbox, uidValidity, uid } = metadata.source;
  const sourceId = await hash(
    new TextEncoder().encode(
      JSON.stringify([account, mailbox, uidValidity, uid]),
    ),
  );
  const sha256 = await hash(raw);
  const hex = sourceId.slice(0, 32);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const candidate = `0-${String(9_999_999_999_999 - metadata.timestamp).padStart(13, "0")}-${uuid}${metadata.folder === "inbox" ? ".eml" : ""}`;
  // Validate before reserving. Large bodies/attachments are not decoded here.
  const headers = await parseRawHeaders(raw);
  await store.DB.prepare(
    `INSERT OR IGNORE INTO mail_imports
    (mailbox_id, source_id, message_id, sha256, metadata) VALUES (${mailboxSql(store.DB)}, ?, ?, ?, ?)`,
  )
    .bind(sourceId, candidate, sha256, JSON.stringify(metadata))
    .run();
  const receipt = await store.DB.prepare(
    `SELECT message_id AS messageId, sha256, metadata,
    completed_at AS completedAt FROM mail_imports WHERE mailbox_id = ${mailboxSql(store.DB)} AND source_id = ?`,
  )
    .bind(sourceId)
    .first<Receipt>();
  if (!receipt || receipt.sha256 !== sha256)
    throw new Error(
      "Import source identity already belongs to different message bytes",
    );
  if (receipt.completedAt !== null)
    return { id: receipt.messageId, status: "skipped" as const };

  // The first attempt owns the mapping/date/flags. A retry must not reset state
  // just because the source mailbox or mapping options have since changed.
  const initial = decodeMetadata(JSON.parse(receipt.metadata));
  const bucket =
    initial.folder === "inbox" ? store.INBOX_MESSAGES : store.SENT_MESSAGES;
  const customMetadata = {
    format: rawMailFormat,
    sha256,
    originalTimestamp: String(initial.timestamp),
    initialUnread: initial.flags.includes("\\Seen") ? "0" : "1",
    initialArchived: initial.archived ? "1" : "0",
  };
  await bucket.put(receipt.messageId, raw, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata,
    onlyIf: { etagDoesNotMatch: "*" },
  });
  const object = await bucket.head(receipt.messageId);
  if (
    !object ||
    object.customMetadata?.sha256 !== sha256 ||
    object.size !== raw.byteLength
  )
    throw new Error("Could not verify the stored original message");
  const mail = describeRawMail(object, headers, initial.folder);
  await store.DB.batch([
    ...(await indexMailStatements(store.DB, mail)),
    store.DB.prepare(
      `UPDATE mail_imports SET completed_at = ? WHERE mailbox_id = ${mailboxSql(store.DB)} AND source_id = ?`,
    ).bind(Date.now(), sourceId),
  ]);
  return { id: receipt.messageId, status: "imported" as const };
};
