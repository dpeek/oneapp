import type { D1Database } from "@cloudflare/workers-types";
import { ByteSize, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  calendarApi,
  calendarExportName,
  calendarImportLimit,
  calendarImportLimitLabel,
  CalendarId,
  CalendarNameWrite,
  CalendarSummary,
  defaultCalendarId,
  defaultCalendarName,
  CalendarWrite,
  type CalendarOccurrence,
} from "../calendar-contract.ts";
import { calendarDays, calendarTimeZone } from "../calendar-time.ts";
import {
  attachmentDisposition,
  jsonError,
  privateHeaders,
} from "./api-response.ts";
import { AppAuth, ownerId, type authHttp } from "./auth.ts";
import {
  calendarOccurrences,
  calendarRange,
  canEditCalendarEvent,
  combineCalendarEvents,
  readCalendarImport,
  writeCalendarEvent,
  type CalendarEventRow,
} from "./calendar-ical.ts";
import { pushConfiguration, type PushEnv } from "./push-delivery.ts";
import { activePushSubscription } from "./push-store.ts";

const query = HttpServerRequest.schemaSearchParams(
  Schema.Struct({ start: Schema.String, timeZone: Schema.String }),
).pipe(Effect.option);
const importBody = HttpServerRequest.schemaBodyJson(
  Schema.Struct({
    ics: Schema.String,
    calendarId: Schema.optional(CalendarId),
  }),
).pipe(
  // A JSON escape can take six bytes, and the object has other fields.
  Effect.provideService(
    HttpServerRequest.MaxBodySize,
    ByteSize.bytes(calendarImportLimit * 6 + 1024),
  ),
  Effect.option,
);
const exportQuery = HttpServerRequest.schemaSearchParams(
  Schema.Struct({ calendarId: Schema.optional(CalendarId) }),
).pipe(Effect.option);
const nameBody = HttpServerRequest.schemaBodyJson(CalendarNameWrite).pipe(
  Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.kibibytes(2)),
  Effect.option,
);
const editBody = HttpServerRequest.schemaBodyJson(CalendarWrite).pipe(
  Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.kibibytes(64)),
  Effect.option,
);
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

type CalendarSummary = typeof CalendarSummary.Type;
const isCalendarId = Schema.is(CalendarId);

export const ensureDefaultCalendar = (db: D1Database, account: string) =>
  db
    .prepare(
      `INSERT INTO calendars (account_id, id, name, name_key) VALUES (?, ?, ?, ?)
     ON CONFLICT (account_id, id) DO NOTHING`,
    )
    .bind(
      account,
      defaultCalendarId,
      defaultCalendarName,
      defaultCalendarName.toLowerCase(),
    )
    .run();

const getCalendar = async (db: D1Database, account: string, id: string) => {
  if (id === defaultCalendarId) await ensureDefaultCalendar(db, account);
  return db
    .prepare("SELECT id, name FROM calendars WHERE account_id = ? AND id = ?")
    .bind(account, id)
    .first<CalendarSummary>();
};

const loadRows = (db: D1Database, account: string, calendarId: string) =>
  db
    .prepare(
      `SELECT id, calendar_id, revision, ics, remind_at FROM calendar_events
     WHERE account_id = ? AND calendar_id = ? AND deleted = 0`,
    )
    .bind(account, calendarId)
    .all<CalendarEventRow>();

export const listCalendarWeek = async (
  env: PushEnv,
  account: string,
  range: ReturnType<typeof calendarRange>,
) => {
  await ensureDefaultCalendar(env.DB, account);
  const [rows, subscription, calendars] = await Promise.all([
    // Bounds are UTC dates (or calendar dates for floating and all-day
    // events). Allow an extra day for viewing from a different time zone.
    env.DB.prepare(
      `SELECT id, calendar_id, revision, ics, remind_at FROM calendar_events
       WHERE account_id = ? AND deleted = 0
         AND (first_day IS NULL OR first_day <= ?)
         AND (last_day IS NULL OR last_day >= ?)`,
    )
      .bind(account, calendarDays(range.end, 1), calendarDays(range.start, -1))
      .all<CalendarEventRow>(),
    pushConfiguration(env)
      ? env.DB.prepare(
          `SELECT 1 FROM push_subscriptions p WHERE p.account_id = ?
             AND ${activePushSubscription} LIMIT 1`,
        )
          .bind(account, Date.now(), Date.now())
          .first()
      : null,
    env.DB.prepare(
      "SELECT id, name FROM calendars WHERE account_id = ? ORDER BY id <> ?, name_key, id",
    )
      .bind(account, defaultCalendarId)
      .all<CalendarSummary>(),
  ]);
  const events: CalendarOccurrence[] = [];
  let incomplete = false;
  for (const row of rows.results) {
    try {
      const result = calendarOccurrences(row, range);
      events.push(...result.events);
      incomplete ||= result.incomplete;
    } catch {
      incomplete = true;
    }
  }
  events.sort(
    (a, b) =>
      Number(b.allDay) - Number(a.allDay) ||
      a.start.localeCompare(b.start) ||
      a.title.localeCompare(b.title),
  );
  return {
    calendars: calendars.results,
    events,
    incomplete,
    remindersAvailable: Boolean(subscription),
  };
};

const chunksFor = (rows: readonly object[]) => {
  const chunks: string[] = [];
  const encoder = new TextEncoder();
  let entries: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const json = JSON.stringify(row);
    const length = encoder.encode(json).byteLength + 1;
    if (entries.length && bytes + length > 96 * 1024) {
      chunks.push(`[${entries.join(",")}]`);
      entries = [];
      bytes = 0;
    }
    entries.push(json);
    bytes += length;
  }
  if (entries.length) chunks.push(`[${entries.join(",")}]`);
  return chunks;
};

export const importCalendar = async (
  db: D1Database,
  account: string,
  calendarId: string,
  parsed: ReturnType<typeof readCalendarImport>,
  commit: boolean,
) => {
  const { events, total, warnings } = parsed;
  if (commit && events.length) {
    const rows = events.map((event) => ({
      ...event,
      id: crypto.randomUUID(),
      revision: crypto.randomUUID(),
    }));
    const result = await db.batch(
      chunksFor(rows).map((chunk) =>
        db
          .prepare(
            `INSERT INTO calendar_events (account_id, calendar_id, uid, ics, id, revision, first_day, last_day)
             SELECT ?1, ?2, value ->> '$.uid', value ->> '$.ics', value ->> '$.id', value ->> '$.revision',
               value ->> '$.firstDay', value ->> '$.lastDay'
             FROM json_each(?3) AS input
             WHERE NOT EXISTS (
               SELECT 1 FROM calendar_moved_uids
               WHERE account_id = ?1 AND calendar_id = ?2 AND uid = input.value ->> '$.uid'
             )
             ON CONFLICT (account_id, calendar_id, uid) DO NOTHING`,
          )
          .bind(account, calendarId, chunk),
      ),
    );
    const imported = result.reduce((sum, item) => sum + item.meta.changes, 0);
    return {
      total,
      available: imported,
      existing: events.length - imported,
      imported,
      warnings,
    };
  }
  const known = events.length
    ? await db
        .prepare(
          `SELECT COUNT(*) AS total FROM json_each(?3) AS input
           WHERE EXISTS (
             SELECT 1 FROM calendar_events WHERE account_id = ?1 AND calendar_id = ?2 AND uid = input.value
           ) OR EXISTS (
             SELECT 1 FROM calendar_moved_uids WHERE account_id = ?1 AND calendar_id = ?2 AND uid = input.value
           )`,
        )
        .bind(
          account,
          calendarId,
          JSON.stringify(events.map((event) => event.uid)),
        )
        .first<number>("total")
    : 0;
  const existing = known ?? 0;
  return {
    total,
    available: events.length - existing,
    existing,
    imported: 0,
    warnings,
  };
};

const json = (value: unknown) =>
  HttpServerResponse.json(value, { headers: privateHeaders });
const noContent = () =>
  HttpServerResponse.empty({ status: 204, headers: privateHeaders });
const missing = () => jsonError(404, "Calendar not found.");
const stale = () =>
  jsonError(409, "This event changed. Refresh the calendar and try again.");

export const calendarRoutes = (
  http: ReturnType<typeof authHttp>,
  env: PushEnv,
) => {
  const db = env.DB;
  const session = Effect.gen(function* () {
    const auth = yield* AppAuth;
    return yield* auth.requireSession;
  });
  const handle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catch((error) => {
        const tag =
          typeof error === "object" && error !== null && "_tag" in error
            ? error._tag
            : null;
        return tag === "AuthenticationRequired"
          ? jsonError(401, "Sign in required")
          : tag === "HookDenied"
            ? jsonError(403, "Request not allowed")
            : jsonError(503, "Calendar is unavailable. Try again.");
      }),
    );

  const importRoute = (commit: boolean) =>
    handle(
      http.protect(
        Effect.gen(function* () {
          const account = yield* session;
          if (account.subjectId !== ownerId)
            return yield* jsonError(403, "Request not allowed");
          const body = yield* importBody;
          if (
            body._tag === "None" ||
            new TextEncoder().encode(body.value.ics).byteLength >
              calendarImportLimit
          )
            return yield* jsonError(
              400,
              `Choose an .ics file up to ${calendarImportLimitLabel}.`,
            );
          const calendarId = body.value.calendarId ?? defaultCalendarId;
          const calendar = yield* Effect.tryPromise(() =>
            getCalendar(db, account.subjectId, calendarId),
          );
          if (!calendar) return yield* missing();
          let parsed: ReturnType<typeof readCalendarImport>;
          try {
            parsed = readCalendarImport(body.value.ics);
          } catch (error) {
            return yield* jsonError(
              400,
              errorText(error, "Could not read this calendar file."),
            );
          }
          const report = yield* Effect.tryPromise(() =>
            importCalendar(db, account.subjectId, calendarId, parsed, commit),
          );
          return yield* json(report);
        }),
      ),
    );

  const writeName = (create: boolean) =>
    handle(
      http.protect(
        Effect.gen(function* () {
          const { subjectId } = yield* session;
          if (subjectId !== ownerId)
            return yield* jsonError(403, "Request not allowed");
          const { id } = yield* HttpRouter.params;
          if (!isCalendarId(id) || (create && id === defaultCalendarId))
            return yield* missing();
          const body = yield* nameBody;
          const name =
            body._tag === "Some" ? body.value.name.trim().normalize("NFC") : "";
          if (!name || /[\u0000-\u001f\u007f]/u.test(name))
            return yield* jsonError(
              400,
              "Enter a calendar name up to 80 characters.",
            );
          const nameKey = name.toLowerCase();
          yield* Effect.tryPromise(() => ensureDefaultCalendar(db, subjectId));
          const result = yield* Effect.tryPromise(() =>
            (create
              ? db
                  .prepare(
                    "INSERT INTO calendars (account_id, id, name, name_key) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
                  )
                  .bind(subjectId, id, name, nameKey)
              : db
                  .prepare(
                    "UPDATE OR IGNORE calendars SET name = ?, name_key = ? WHERE account_id = ? AND id = ?",
                  )
                  .bind(name, nameKey, subjectId, id)
            ).run(),
          );
          if (result.meta.changes) return yield* json({ id, name });
          const existing = yield* Effect.tryPromise(() =>
            getCalendar(db, subjectId, id),
          );
          if (create && existing?.name === name) return yield* json(existing);
          if (!create && !existing) return yield* missing();
          return yield* jsonError(
            409,
            "A calendar with that name already exists.",
          );
        }),
      ),
    );

  return Layer.mergeAll(
    HttpRouter.add("POST", `${calendarApi}/calendars/:id`, writeName(true)),
    HttpRouter.add("PUT", `${calendarApi}/calendars/:id`, writeName(false)),
    HttpRouter.add(
      "GET",
      calendarApi,
      handle(
        Effect.gen(function* () {
          const account = yield* session;
          if (account.subjectId !== ownerId)
            return yield* jsonError(403, "Request not allowed");
          const input = yield* query;
          if (input._tag === "None")
            return yield* jsonError(400, "Choose a week and a time zone.");
          let range: ReturnType<typeof calendarRange>;
          try {
            range = calendarRange(
              input.value.start,
              calendarTimeZone(input.value.timeZone),
            );
          } catch {
            return yield* jsonError(400, "Choose a valid week and time zone.");
          }
          const week = yield* Effect.tryPromise(() =>
            listCalendarWeek(env, account.subjectId, range),
          );
          return yield* json(week);
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      `${calendarApi}/export`,
      handle(
        Effect.gen(function* () {
          const account = yield* session;
          if (account.subjectId !== ownerId)
            return yield* jsonError(403, "Request not allowed");
          const query = yield* exportQuery;
          if (query._tag === "None") return yield* missing();
          const calendarId = query.value.calendarId ?? defaultCalendarId;
          const calendar = yield* Effect.tryPromise(() =>
            getCalendar(db, account.subjectId, calendarId),
          );
          if (!calendar) return yield* missing();
          const rows = yield* Effect.tryPromise(() =>
            loadRows(db, account.subjectId, calendarId),
          );
          return HttpServerResponse.text(
            combineCalendarEvents(
              rows.results.map((row) => row.ics),
              calendar.name,
            ),
            {
              contentType: "text/calendar; charset=utf-8",
              headers: {
                ...privateHeaders,
                "content-disposition": attachmentDisposition(
                  calendarExportName(calendar.name),
                ),
              },
            },
          );
        }),
      ),
    ),
    HttpRouter.add("POST", `${calendarApi}/import/preview`, importRoute(false)),
    HttpRouter.add("POST", `${calendarApi}/import`, importRoute(true)),
    HttpRouter.add(
      "PUT",
      `${calendarApi}/events/:id`,
      handle(
        http.protect(
          Effect.gen(function* () {
            const account = yield* session;
            if (account.subjectId !== ownerId)
              return yield* jsonError(403, "Request not allowed");
            const { id } = yield* HttpRouter.params;
            const input = yield* editBody;
            if (!id || !uuid.test(id) || input._tag === "None")
              return yield* jsonError(400, "Invalid event.");
            const { draft, revision } = input.value;
            const row =
              revision === null
                ? null
                : yield* Effect.tryPromise(() =>
                    db
                      .prepare(
                        "SELECT uid, ics, revision, calendar_id FROM calendar_events WHERE account_id = ? AND id = ? AND deleted = 0",
                      )
                      .bind(account.subjectId, id)
                      .first<{
                        uid: string;
                        ics: string;
                        revision: string;
                        calendar_id: string;
                      }>(),
                  );
            if (revision !== null && row?.revision !== revision)
              return yield* stale();
            const calendarId =
              input.value.calendarId ?? row?.calendar_id ?? defaultCalendarId;
            const calendar = yield* Effect.tryPromise(() =>
              getCalendar(db, account.subjectId, calendarId),
            );
            if (!calendar) return yield* missing();
            const uid = row?.uid ?? `${id}@oneapp`;
            let next: ReturnType<typeof writeCalendarEvent>;
            try {
              next = writeCalendarEvent(draft, uid, row?.ics);
            } catch (error) {
              return yield* jsonError(
                400,
                errorText(error, "Check the event dates and title."),
              );
            }
            if (!next) return yield* jsonError(409, "This event is read-only.");
            const moving = row !== null && row.calendar_id !== calendarId;
            const changes = yield* Effect.tryPromise(async () => {
              const nextRevision = crypto.randomUUID();
              const values = [
                next.ics,
                nextRevision,
                next.remindAt,
                next.reminderEndsAt,
                next.firstDay,
                next.lastDay,
                calendarId,
                account.subjectId,
                id,
              ] as const;
              if (revision === null) {
                const result = await db
                  .prepare(
                    `INSERT INTO calendar_events (ics, revision, remind_at, reminder_ends_at, first_day, last_day, calendar_id, account_id, id, uid)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
                  )
                  .bind(...values, uid)
                  .run();
                return result.meta.changes;
              }
              const write = db
                .prepare(
                  `UPDATE OR IGNORE calendar_events SET ics = ?, revision = ?, remind_at = ?,
                    reminder_ends_at = ?, first_day = ?, last_day = ?, calendar_id = ?
                 WHERE account_id = ? AND id = ? AND revision = ? AND deleted = 0`,
                )
                .bind(...values, revision);
              if (!moving) return (await write.run()).meta.changes;
              // Keep the original calendar's import identity only when this
              // revision was actually moved. The event ID and outbox stay put.
              const [result] = await db.batch([
                write,
                db
                  .prepare(
                    `INSERT INTO calendar_moved_uids (account_id, calendar_id, uid)
                   SELECT ?, ?, ? WHERE EXISTS (
                     SELECT 1 FROM calendar_events WHERE account_id = ? AND id = ? AND revision = ?
                   ) ON CONFLICT DO NOTHING`,
                  )
                  .bind(
                    account.subjectId,
                    row.calendar_id,
                    uid,
                    account.subjectId,
                    id,
                    nextRevision,
                  ),
              ]);
              return result!.meta.changes;
            });
            if (changes) return noContent();
            if (moving) {
              const collision = yield* Effect.tryPromise(() =>
                db
                  .prepare(
                    "SELECT 1 FROM calendar_events WHERE account_id = ? AND calendar_id = ? AND uid = ?",
                  )
                  .bind(account.subjectId, calendarId, uid)
                  .first(),
              );
              if (collision)
                return yield* jsonError(
                  409,
                  "The destination calendar already has a copy of this event.",
                );
            }
            return yield* stale();
          }),
        ),
      ),
    ),
    HttpRouter.add(
      "DELETE",
      `${calendarApi}/events/:id`,
      handle(
        http.protect(
          Effect.gen(function* () {
            const account = yield* session;
            if (account.subjectId !== ownerId)
              return yield* jsonError(403, "Request not allowed");
            const { id } = yield* HttpRouter.params;
            const request = yield* HttpServerRequest.HttpServerRequest;
            const revision = request.headers["if-match"];
            if (!id || !uuid.test(id) || !revision || !uuid.test(revision))
              return yield* jsonError(400, "Invalid event.");
            const row = yield* Effect.tryPromise(() =>
              db
                .prepare(
                  "SELECT ics, revision FROM calendar_events WHERE account_id = ? AND id = ? AND deleted = 0",
                )
                .bind(account.subjectId, id)
                .first<{ ics: string; revision: string }>(),
            );
            if (!row) return noContent();
            if (row.revision !== revision) return yield* stale();
            if (!canEditCalendarEvent(row.ics))
              return yield* jsonError(409, "This event is read-only.");
            const result = yield* Effect.tryPromise(() =>
              db
                .prepare(
                  `UPDATE calendar_events SET deleted = 1, ics = '', remind_at = NULL, reminder_ends_at = NULL, first_day = NULL, last_day = NULL
         WHERE account_id = ? AND id = ? AND revision = ? AND deleted = 0`,
                )
                .bind(account.subjectId, id, revision)
                .run(),
            );
            return result.meta.changes ? noContent() : yield* stale();
          }),
        ),
      ),
    ),
  );
};
