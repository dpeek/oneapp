import { workspacePath } from "@orumai/core";
import { Schema } from "effect";

export const calendarPath = `${workspacePath}/calendar`;
export const calendarApi = "/api/calendar";
export const calendarImportLimit = 2 * 1024 * 1024;
export const calendarImportLimitLabel = `${calendarImportLimit / (1024 * 1024)} MiB`;
export const calendarReminderMinutes = 10;
export const defaultCalendarId = "default";
export const defaultCalendarName = "Personal";
export const defaultCalendarColor = "#4b43ad";
export const calendarNameLimit = 80;
export const calendarExportName = (name: string) =>
  (name
    .replace(/[\\/:*?"<>|\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "_")
    .replace(/^[.]+|[. ]+$/gu, "")
    .toWellFormed() || "orumai-calendar") + ".ics";

export const CalendarId = Schema.String.check(
  Schema.isPattern(
    /^(?:default|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u,
  ),
);
export const CalendarRoute = Schema.Struct({ id: Schema.NullOr(CalendarId) });
const isCalendarId = Schema.is(CalendarId);
export const calendarListPath = (id: string | null) =>
  id === null ? calendarPath : `${calendarPath}/${id}`;

export const calendarRouteFor = (
  pathname: string,
): typeof CalendarRoute.Type | null => {
  const path = pathname.replace(/\/$/u, "");
  if (path === calendarPath) return { id: null };
  if (!path.startsWith(`${calendarPath}/`)) return null;
  const id = path.slice(calendarPath.length + 1);
  return isCalendarId(id) ? { id } : null;
};

export const CalendarColor = Schema.String.check(
  Schema.isPattern(/^#[0-9a-f]{6}$/iu),
);
export const CalendarSummary = Schema.Struct({
  id: CalendarId,
  name: Schema.String,
  color: CalendarColor,
});
export const CalendarPreferencesWrite = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(calendarNameLimit)),
  color: Schema.optional(Schema.String),
});

const text = (limit: number) => Schema.String.check(Schema.isMaxLength(limit));
export const CalendarDraft = Schema.Struct({
  title: text(250),
  location: text(500),
  description: text(8000),
  allDay: Schema.Boolean,
  start: text(32),
  end: text(32),
  timeZone: text(100),
  reminder: Schema.Boolean,
});
export type CalendarDraft = typeof CalendarDraft.Type;

export const CalendarFrequency = Schema.Literals([
  "daily",
  "weekly",
  "monthly",
]);
export const CalendarRepeat = Schema.Struct({
  frequency: CalendarFrequency,
  until: Schema.NullOr(text(10)),
});
export type CalendarRepeat = typeof CalendarRepeat.Type;

export const CalendarOccurrence = Schema.Struct({
  id: Schema.String,
  calendarId: CalendarId,
  occurrence: Schema.String,
  title: Schema.String,
  location: Schema.String,
  description: Schema.String,
  allDay: Schema.Boolean,
  start: Schema.String,
  end: Schema.String,
  recurring: Schema.Boolean,
  draft: Schema.NullOr(CalendarDraft),
  series: Schema.optional(
    Schema.Struct({ draft: CalendarDraft, repeat: CalendarRepeat }),
  ),
  revision: Schema.String,
});
export type CalendarOccurrence = typeof CalendarOccurrence.Type;

export const CalendarWeek = Schema.Struct({
  calendars: Schema.Array(CalendarSummary),
  events: Schema.Array(CalendarOccurrence),
  incomplete: Schema.Boolean,
  remindersAvailable: Schema.Boolean,
});
export const CalendarImportReport = Schema.Struct({
  total: Schema.Number,
  available: Schema.Number,
  existing: Schema.Number,
  imported: Schema.Number,
  warnings: Schema.Array(Schema.String),
});

export const CalendarWrite = Schema.Struct({
  calendarId: Schema.optional(CalendarId),
  draft: CalendarDraft,
  revision: Schema.NullOr(Schema.String),
  repeat: Schema.optional(Schema.NullOr(CalendarRepeat)),
  occurrence: Schema.optional(text(32)),
});
