import { Schema } from "effect";

export const calendarPath = "/calendar";
export const calendarApi = "/api/calendar";
export const calendarImportLimit = 2 * 1024 * 1024;
export const calendarImportLimitLabel = `${calendarImportLimit / (1024 * 1024)} MiB`;
export const calendarReminderMinutes = 10;
export const defaultCalendarId = "default";
export const defaultCalendarName = "Personal";
export const calendarNameLimit = 80;
export const calendarExportName = (name: string) =>
  (name
    .replace(/[\\/:*?"<>|\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "_")
    .replace(/^[.]+|[. ]+$/gu, "")
    .toWellFormed() || "oneapp-calendar") + ".ics";

export const CalendarId = Schema.String.check(
  Schema.isPattern(
    /^(?:default|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u,
  ),
);
export const CalendarSummary = Schema.Struct({
  id: CalendarId,
  name: Schema.String,
});
export const CalendarNameWrite = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(calendarNameLimit)),
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
});
