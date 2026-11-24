import { calendarPath, calendarReminderMinutes } from "../calendar-contract.ts";
import {
  prepareWebPush,
  pushConfiguration,
  retryDelayForPush,
  type PushEnv,
  type PushSubscription,
} from "./push-delivery.ts";
import { activePushSubscription } from "./push-store.ts";

type Job = {
  event_id: string;
  subscription_id: string;
  remind_at: number;
  expires_at: number;
  attempts: number;
};

export const deliverCalendarPush = async (
  env: PushEnv,
  send: (input: string, init: RequestInit) => Promise<Response> = fetch,
  now = Date.now(),
) => {
  const config = pushConfiguration(env);
  if (!config) return;

  const db = env.DB;
  await db.batch([
    db
      .prepare("DELETE FROM calendar_push_outbox WHERE expires_at <= ?")
      .bind(now),
    db
      .prepare(
        `INSERT OR IGNORE INTO calendar_push_outbox
         (event_id, subscription_id, remind_at, expires_at, next_attempt_at)
       SELECT e.id, p.id, e.remind_at, e.reminder_ends_at, ?
       FROM calendar_events e JOIN push_subscriptions p ON p.account_id = e.account_id
       WHERE e.deleted = 0 AND e.remind_at > ? AND e.remind_at <= ? AND e.reminder_ends_at > ?
         AND ${activePushSubscription}`,
      )
      .bind(now, now - calendarReminderMinutes * 60_000, now, now, now, now),
  ]);

  const lease = crypto.randomUUID();
  const { results } = await db
    .prepare(
      `UPDATE calendar_push_outbox SET lease = ?, next_attempt_at = ?, attempts = attempts + 1
     WHERE (event_id, subscription_id, remind_at) IN (
       SELECT event_id, subscription_id, remind_at FROM calendar_push_outbox
       WHERE completed_at IS NULL AND next_attempt_at <= ? AND expires_at > ?
       ORDER BY expires_at, next_attempt_at LIMIT 16
     ) RETURNING event_id, subscription_id, remind_at, expires_at, attempts`,
    )
    .bind(lease, now + 60_000, now, now)
    .all<Job>();

  const deliver = async (job: Job) => {
    const key = [job.event_id, job.subscription_id, job.remind_at, lease];
    const complete = () =>
      db
        .prepare(
          `UPDATE calendar_push_outbox SET completed_at = ?, lease = NULL
       WHERE event_id = ? AND subscription_id = ? AND remind_at = ? AND lease = ?`,
        )
        .bind(now, ...key)
        .run();
    const subscription = await db
      .prepare(
        `SELECT p.endpoint, p.p256dh, p.auth FROM push_subscriptions p
       JOIN calendar_events e ON e.account_id = p.account_id
       WHERE e.id = ? AND p.id = ? AND e.deleted = 0 AND e.remind_at = ?
         AND e.reminder_ends_at > ? AND ${activePushSubscription}`,
      )
      .bind(job.event_id, job.subscription_id, job.remind_at, now, now, now)
      .first<PushSubscription>();
    if (!subscription) {
      await db
        .prepare(
          `DELETE FROM calendar_push_outbox
         WHERE event_id = ? AND subscription_id = ? AND remind_at = ? AND lease = ?`,
        )
        .bind(...key)
        .run();
      return;
    }

    let retryAfter = 0;
    try {
      const push = prepareWebPush(
        subscription,
        config,
        {
          type: "calendar",
          tag: `calendar:${job.event_id}:${job.remind_at}`,
          url: calendarPath,
        },
        job.expires_at - now,
      );
      const response = await send(push.endpoint, push.request);
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
      retryAfter = retryDelayForPush(response, now);
      console.warn("Calendar push delivery failed", {
        status: response.status,
        attempt: job.attempts,
      });
    } catch {
      console.warn("Calendar push delivery unavailable", {
        attempt: job.attempts,
      });
    }
    const delay = Math.max(
      retryAfter,
      60_000 * 2 ** Math.min(job.attempts - 1, 3),
    );
    if (now + delay >= job.expires_at) {
      await complete();
      return;
    }
    await db
      .prepare(
        `UPDATE calendar_push_outbox SET next_attempt_at = ?, lease = NULL
       WHERE event_id = ? AND subscription_id = ? AND remind_at = ? AND lease = ?`,
      )
      .bind(now + delay, ...key)
      .run();
  };

  for (let offset = 0; offset < results.length; offset += 4)
    await Promise.all(results.slice(offset, offset + 4).map(deliver));
};
