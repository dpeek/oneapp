import type { D1Database } from "@cloudflare/workers-types";
import type { MailDatabase } from "./mailbox.ts";

export const pushLifetimeMs = 24 * 60 * 60 * 1000;
// Checked both when enqueueing and immediately before sending. A revoked or
// expired browser session must not continue to receive mail notifications.
export const activePushSubscription = `EXISTS (
  SELECT 1 FROM oneapp_auth_sessions s
  JOIN accounts a ON a.id = s.subject_id AND a.security_revision = s.security_revision
  JOIN mailboxes b ON b.owner_account_id = a.id
  WHERE s.session_id = p.session_id AND s.subject_id = p.account_id
    AND s.security_revision = p.security_revision AND a.active = 1
    AND b.id = p.mailbox_id AND s.expires_at > ? AND s.absolute_expires_at > ?
)`;

export const enqueueMailPush = (
  db: MailDatabase,
  id: string,
  timestamp: number,
  now = Date.now(),
) =>
  db
    .prepare(
      `INSERT OR IGNORE INTO mail_push_outbox
    (mailbox_id, message_id, subscription_id, created_at, next_attempt_at)
    SELECT p.mailbox_id, ?, p.id, ?, ? FROM push_subscriptions p
    WHERE p.mailbox_id = ? AND p.created_at <= ? AND ? > ? AND ${activePushSubscription}`,
    )
    .bind(
      id,
      timestamp,
      now,
      db.mailboxId,
      timestamp,
      timestamp,
      now - pushLifetimeMs,
      now,
      now,
    );

export const removeSessionPush = (db: D1Database, sessionId: string) =>
  db
    .prepare("DELETE FROM push_subscriptions WHERE session_id = ?")
    .bind(sessionId)
    .run();
