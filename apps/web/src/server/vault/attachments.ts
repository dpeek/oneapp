import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import {
  attachmentHeaderLength,
  type AttachmentMetadata,
  vaultAttachmentLimit,
  vaultAttachmentQuota,
  vaultAttachmentRequestLimit,
} from "../../vault-attachment-contract.ts";
import { digest } from "../digest.ts";
import { type VaultAuthorization } from "./personal.ts";

type DB = WorkerEnv["DB"];
type Bucket = WorkerEnv["VAULT_FILES"];
export type UploadMetadata = Omit<AttachmentMetadata, "id">;
type Attachment = AttachmentMetadata & {
  itemId: string;
  revisionAt: number;
  expiresAt: number;
  readyAt: number | null;
};

const pendingLifetime = 30 * 60_000;
const columns = (a: string) =>
  `${a}.id, ${a}.item_id AS itemId, ${a}.name, ${a}.wrapped_key AS wrappedKey, ${a}.size,
   ${a}.revision_at AS revisionAt, ${a}.expires_at AS expiresAt, ${a}.ready_at AS readyAt`;

const validSize = (size: number) =>
  Number.isInteger(size) &&
  size >= 65 &&
  size <= vaultAttachmentLimit &&
  (size - attachmentHeaderLength) % 16 === 0;

export const hasAttachmentStore = (env: Pick<WorkerEnv, "VAULT_FILES">) =>
  env.VAULT_FILES !== undefined;

export const reserveAttachment = async (
  db: DB,
  authorization: VaultAuthorization,
  item: string,
  expectedRevision: number,
  metadata: UploadMetadata,
) => {
  if (!validSize(metadata.size)) return { status: "size" } as const;
  const now = Date.now();
  const key = await digest(
    JSON.stringify([metadata.name, metadata.wrappedKey, metadata.size]),
  );
  const id = crypto.randomUUID().replaceAll("-", "");
  const scope = authorization.parameters(now);
  const current = `(${authorization.query}) v JOIN personal_vault_logins i ON i.vault_id = v.id AND i.id = ?`;
  const [, , attachments, items] = await db.batch<
    Attachment | { revisionAt: number }
  >([
    // Release expired reservations for this item before checking the same payload.
    db
      .prepare(
        `DELETE FROM personal_vault_attachments WHERE item_id IN (SELECT i.id FROM ${current})
      AND ready_at IS NULL AND expires_at <= ?`,
      )
      .bind(...scope, item, now),
    db
      .prepare(
        `INSERT INTO personal_vault_attachments (id, item_id, name, wrapped_key, size, item_key, revision_at, expires_at, create_digest)
       SELECT ?, i.id, ?, ?, ?, i.wrapped_key, max(v.revision_at + 1, i.revision_at + 1, ?), ?, ?
       FROM ${current}
       WHERE i.deleted_at IS NULL AND i.revision_at = ? AND
         (SELECT coalesce(sum(a.size), 0) FROM personal_vault_attachments a
          JOIN personal_vault_logins existing ON existing.id = a.item_id
          WHERE existing.vault_id = v.id AND (a.ready_at IS NOT NULL OR a.expires_at > ?)) + ? <= ?
       ON CONFLICT (item_id, create_digest) DO NOTHING`,
      )
      .bind(
        id,
        metadata.name,
        metadata.wrappedKey,
        metadata.size,
        now,
        now + pendingLifetime,
        key,
        ...scope,
        item,
        expectedRevision,
        now,
        metadata.size,
        vaultAttachmentQuota,
      ),
    db
      .prepare(
        `SELECT ${columns("a")} FROM ${current} JOIN personal_vault_attachments a ON a.item_id = i.id
       WHERE a.create_digest = ? AND a.item_key = i.wrapped_key AND i.deleted_at IS NULL`,
      )
      .bind(...scope, item, key),
    db
      .prepare(
        `SELECT i.revision_at AS revisionAt FROM ${current} WHERE i.deleted_at IS NULL`,
      )
      .bind(...scope, item),
  ]);
  const saved = attachments?.results[0];
  if (saved && "id" in saved)
    return { status: "ready", attachment: saved } as const;
  const currentItem = items?.results[0];
  return {
    status: !currentItem
      ? "not_found"
      : currentItem.revisionAt !== expectedRevision
        ? "stale"
        : "quota",
  } as const;
};

export const readAttachment = (
  db: DB,
  authorization: VaultAuthorization,
  item: string,
  id: string,
) =>
  db
    .prepare(
      `SELECT ${columns("a")} FROM (${authorization.query}) v
     JOIN personal_vault_logins i ON i.vault_id = v.id AND i.id = ?
     JOIN personal_vault_attachments a ON a.item_id = i.id AND a.id = ?`,
    )
    .bind(...authorization.parameters(Date.now()), item, id)
    .first<Attachment>();

export const readEncryptedUpload = async (request: Request, size: number) => {
  const type = request.headers.get("content-type") ?? "";
  const multipart = /^multipart\/form-data;/iu.test(type);
  if (!multipart && type !== "application/octet-stream") return null;
  const limit = multipart
    ? size + (vaultAttachmentRequestLimit - vaultAttachmentLimit)
    : size;
  const declared = Number(request.headers.get("content-length"));
  if (declared > limit) return null;
  const stream = request.body?.getReader();
  if (!stream) return null;
  const bytes = new Uint8Array(limit);
  let offset = 0;
  while (true) {
    const chunk = await stream.read();
    if (chunk.done) break;
    if (offset + chunk.value.byteLength > limit) {
      await stream.cancel();
      return null;
    }
    bytes.set(chunk.value, offset);
    offset += chunk.value.byteLength;
  }
  let data = bytes.subarray(0, offset);
  if (multipart) {
    try {
      const form = await new Response(data, {
        headers: { "content-type": type },
      }).formData();
      const part = form.get("data");
      if (
        form.getAll("data").length !== 1 ||
        !(part instanceof File) ||
        part.size !== size
      )
        return null;
      data = new Uint8Array(await part.arrayBuffer());
    } catch {
      return null;
    }
  }
  return data.byteLength === size && data[0] === 2 ? data : null;
};

const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

export const saveAttachmentBytes = async (
  db: DB,
  bucket: Bucket,
  authorization: VaultAuthorization,
  item: string,
  id: string,
  request: Request,
) => {
  const attachment = await readAttachment(db, authorization, item, id);
  if (
    !attachment ||
    (attachment.readyAt === null && attachment.expiresAt <= Date.now())
  )
    return "not_found";
  const bytes = await readEncryptedUpload(request, attachment.size);
  if (!bytes) return "size";
  const hash = await sha256(bytes);
  if (attachment.readyAt !== null) {
    const existing = await bucket.head(id);
    return existing?.customMetadata?.sha256 === hash &&
      (await readAttachment(db, authorization, item, id))?.readyAt != null
      ? "updated"
      : "stale";
  }
  if (!(await readAttachment(db, authorization, item, id))) return "not_found";
  const stored = await bucket.put(id, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { sha256: hash },
  });
  if (!stored && (await bucket.head(id))?.customMetadata?.sha256 !== hash)
    return "stale";

  const now = Date.now();
  const scope = authorization.parameters(now);
  const current = `(${authorization.query}) v
    JOIN personal_vault_logins i ON i.vault_id = v.id AND i.id = ?
    JOIN personal_vault_attachments a ON a.item_id = i.id AND a.id = ?
    WHERE a.ready_at IS NULL AND a.expires_at > ? AND i.deleted_at IS NULL AND i.wrapped_key = a.item_key`;
  const bind = [...scope, item, id, now];
  const [, , changed] = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE personal_vaults SET revision_at = max(personal_vaults.revision_at + 1, i.revision_at + 1, a.revision_at, ?)
       FROM ${current} AND personal_vaults.id = v.id`,
      )
      .bind(now, ...bind),
    db
      .prepare(
        `UPDATE personal_vault_logins SET revision_at = max(i.revision_at + 1, a.revision_at)
       FROM ${current} AND personal_vault_logins.id = i.id`,
      )
      .bind(...bind),
    db
      .prepare(
        `UPDATE personal_vault_attachments SET ready_at = ? WHERE id IN (SELECT a.id FROM ${current})
       RETURNING id`,
      )
      .bind(now, ...bind),
  ]);
  if (
    changed?.results.length ||
    (await readAttachment(db, authorization, item, id))?.readyAt != null
  )
    return "updated";
  // The same immutable object may already have been finalized by another
  // authorized retry. Only remove it when its reservation has been deleted.
  const alive = await db
    .prepare("SELECT id FROM personal_vault_attachments WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!alive) await bucket.delete(id);
  return "stale";
};

export const deleteAttachment = async (
  db: DB,
  authorization: VaultAuthorization,
  item: string,
  id: string,
) => {
  const now = Date.now();
  const scope = authorization.parameters(now);
  const current = `(${authorization.query}) v
    JOIN personal_vault_logins i ON i.vault_id = v.id AND i.id = ?
    JOIN personal_vault_attachments a ON a.item_id = i.id AND a.id = ? AND (i.deleted_at IS NULL OR a.ready_at IS NULL)`;
  const bind = [...scope, item, id];
  const [, , removed, visible] = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE personal_vaults SET revision_at = max(personal_vaults.revision_at + 1, i.revision_at + 1, ?)
       FROM ${current} WHERE personal_vaults.id = v.id AND a.ready_at IS NOT NULL`,
      )
      .bind(now, ...bind),
    db
      .prepare(
        `UPDATE personal_vault_logins SET revision_at = v.revision_at
       FROM ${current} WHERE personal_vault_logins.id = i.id AND a.ready_at IS NOT NULL`,
      )
      .bind(...bind),
    db
      .prepare(
        `DELETE FROM personal_vault_attachments WHERE id IN (SELECT a.id FROM ${current}) RETURNING id`,
      )
      .bind(...bind),
    db
      .prepare(
        `SELECT i.id FROM (${authorization.query}) v JOIN personal_vault_logins i ON i.vault_id = v.id AND i.id = ? AND i.deleted_at IS NULL`,
      )
      .bind(...scope, item),
  ]);
  return removed?.results.length || visible?.results.length
    ? "updated"
    : "not_found";
};

export const collectAttachments = async (db: DB, bucket: Bucket) => {
  const now = Date.now();
  await db
    .prepare(
      `DELETE FROM personal_vault_attachments WHERE id IN (
      SELECT id FROM personal_vault_attachments WHERE ready_at IS NULL AND expires_at <= ? LIMIT 100
    )`,
    )
    .bind(now)
    .run();
  const due = await db
    .prepare(
      "SELECT id FROM personal_vault_attachment_cleanup WHERE delete_after <= ? LIMIT 100",
    )
    .bind(now)
    .all<{ id: string }>();
  const ids = due.results.map(({ id }: { id: string }) => id);
  if (!ids.length) return;
  await bucket.delete(ids);
  await db
    .prepare(
      "DELETE FROM personal_vault_attachment_cleanup WHERE id IN (SELECT value FROM json_each(?))",
    )
    .bind(JSON.stringify(ids))
    .run();
};

export const downloadAttachment = async (
  db: DB,
  bucket: Bucket,
  authorization: VaultAuthorization,
  item: string,
  id: string,
) => {
  const attachment = await readAttachment(db, authorization, item, id);
  if (attachment?.readyAt == null) return null;
  const object = await bucket.get(id);
  if (!object) return null;
  if (
    object.size !== attachment.size ||
    (await readAttachment(db, authorization, item, id))?.readyAt == null
  ) {
    await object.body.cancel();
    return null;
  }
  return new Response(object.body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/octet-stream",
      "content-length": String(object.size),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
};

export const scheduleAttachmentCleanup = (
  env: WorkerEnv,
  defer: (work: Promise<unknown>) => void,
) => {
  if (env.VAULT_FILES)
    defer(collectAttachments(env.DB, env.VAULT_FILES).catch(() => undefined));
};
