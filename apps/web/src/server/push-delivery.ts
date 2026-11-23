import type { D1Database } from "@cloudflare/workers-types";
import { generateRequestDetails } from "web-push";
import { mailMessagePage } from "../inbox-contract.ts";
import { isPushEndpoint } from "../push-contract.ts";
import { activePushSubscription, pushLifetimeMs } from "./push-store.ts";

export type PushEnv = {
  DB: D1Database;
  PUSH_PUBLIC_KEY?: string;
  PUSH_PRIVATE_KEY?: string;
  PUSH_SUBJECT?: string;
};
export const pushConfiguration = (env: PushEnv) =>
  env.PUSH_PUBLIC_KEY && env.PUSH_PRIVATE_KEY && env.PUSH_SUBJECT
    ? {
        publicKey: env.PUSH_PUBLIC_KEY,
        privateKey: env.PUSH_PRIVATE_KEY,
        subject: env.PUSH_SUBJECT,
      }
    : null;

type Job = {
  mailbox_id: string;
  message_id: string;
  subscription_id: string;
  attempts: number;
  created_at: number;
};
type Subscription = { endpoint: string; p256dh: string; auth: string };

export const deliverMailPush = async (
  env: PushEnv,
  send: (input: string, init: RequestInit) => Promise<Response> = fetch,
  now = Date.now(),
) => {
  const config = pushConfiguration(env);
  if (!config) return;
  const db = env.DB;
  await db
    .prepare(
      `DELETE FROM push_subscriptions AS p WHERE NOT (${activePushSubscription})`,
    )
    .bind(now, now)
    .run();
  await db
    .prepare("DELETE FROM mail_push_outbox WHERE created_at < ?")
    .bind(now - pushLifetimeMs)
    .run();
  const lease = crypto.randomUUID();
  // Atomic leasing prevents an incoming-mail invocation and the cron retry
  // from sending the same job concurrently. Crashed leases expire in a minute.
  const { results } = await db
    .prepare(
      `UPDATE mail_push_outbox SET lease = ?, next_attempt_at = ?, attempts = attempts + 1
    WHERE (mailbox_id, message_id, subscription_id) IN (
      SELECT mailbox_id, message_id, subscription_id FROM mail_push_outbox
      WHERE completed_at IS NULL AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 8
    ) RETURNING mailbox_id, message_id, subscription_id, attempts, created_at`,
    )
    .bind(lease, now + 60_000, now)
    .all<Job>();
  const deliver = async (job: Job) => {
    const key = [job.mailbox_id, job.message_id, job.subscription_id, lease];
    const complete = () =>
      db
        .prepare(
          `UPDATE mail_push_outbox SET completed_at = ?, lease = NULL
      WHERE mailbox_id = ? AND message_id = ? AND subscription_id = ? AND lease = ?`,
        )
        .bind(now, ...key)
        .run();
    const subscription = await db
      .prepare(
        `SELECT p.endpoint, p.p256dh, p.auth FROM push_subscriptions p
      JOIN mail_index_messages m ON m.mailbox_id = p.mailbox_id AND m.id = ?
      WHERE p.id = ? AND p.mailbox_id = ? AND m.deleted = 0 AND m.unread = 1
        AND ${activePushSubscription}`,
      )
      .bind(job.message_id, job.subscription_id, job.mailbox_id, now, now)
      .first<Subscription>();
    if (!subscription) {
      await complete();
      return;
    }
    let retryAfter = 0;
    let stage = "prepare";
    try {
      if (!isPushEndpoint(subscription.endpoint))
        throw new Error("Invalid push endpoint");
      const details = generateRequestDetails(
        { endpoint: subscription.endpoint, keys: subscription },
        JSON.stringify({
          title: "New mail",
          body: "Open OneApp to read your message.",
          tag: `mail:${job.mailbox_id}:${job.message_id}`,
          url: mailMessagePage("all", job.message_id),
        }),
        {
          vapidDetails: config,
          contentEncoding: "aes128gcm",
          urgency: "high",
          TTL: Math.max(
            0,
            Math.floor((job.created_at + pushLifetimeMs - now) / 1000),
          ),
        },
      );
      const headers = new Headers();
      for (const [name, value] of Object.entries(details.headers))
        headers.set(name, String(value));
      stage = "send";
      const response = await send(details.endpoint, {
        method: "POST",
        headers,
        body: new Uint8Array(details.body),
        // Workers does not implement redirect: "error". Return 3xx responses
        // without following them; they take the failure/retry path below.
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel().catch(() => {});
      if (response.ok) {
        await complete();
        return;
      }
      if (response.status === 404 || response.status === 410) {
        await db
          .prepare("DELETE FROM push_subscriptions WHERE id = ?")
          .bind(job.subscription_id)
          .run();
        return;
      }
      const retry = response.headers.get("retry-after");
      if (retry)
        retryAfter = /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : Math.max(0, Date.parse(retry) - now) || 0;
      console.warn("Mail push delivery failed", {
        status: response.status,
        attempt: job.attempts,
      });
    } catch (error) {
      // Keep runtime failures diagnosable without logging subscription secrets.
      let reason = error instanceof Error ? error.message : "Unknown error";
      for (const secret of [
        ...Object.values(subscription),
        ...Object.values(config),
        job.message_id,
        job.mailbox_id,
      ])
        if (secret) reason = reason.split(secret).join("[redacted]");
      reason = reason
        .replace(/https?:\/\/\S+|[A-Za-z0-9_+/=-]{24,}/g, "[redacted]")
        .slice(0, 200);
      console.warn("Mail push delivery unavailable", {
        attempt: job.attempts,
        stage,
        reason,
      });
    }
    const delay = Math.min(
      pushLifetimeMs,
      Math.max(
        retryAfter,
        Math.min(3_600_000, 60_000 * 2 ** Math.min(job.attempts - 1, 6)),
      ),
    );
    await db
      .prepare(
        `UPDATE mail_push_outbox SET next_attempt_at = ?, lease = NULL
      WHERE mailbox_id = ? AND message_id = ? AND subscription_id = ? AND lease = ?`,
      )
      .bind(now + delay, ...key)
      .run();
  };
  for (let offset = 0; offset < results.length; offset += 4)
    await Promise.all(results.slice(offset, offset + 4).map(deliver));
};
