import { Temporal } from "@js-temporal/polyfill";
import type { CalendarDraft } from "./calendar-contract.ts";

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u;

export const calendarDate = (value: string) => {
  if (!datePattern.test(value)) throw new RangeError("Expected a date");
  return Temporal.PlainDate.from(value);
};

export const calendarTimeZone = (value: string) => {
  if (!value || /^[+-]/u.test(value))
    throw new RangeError("Expected a time zone");
  return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions()
    .timeZone;
};

const localDateTime = (value: string) => {
  if (!dateTimePattern.test(value))
    throw new RangeError("Expected a date and time.");
  return Temporal.PlainDateTime.from(value);
};

export const calendarInstant = (value: string, timeZone: string) =>
  localDateTime(value).toZonedDateTime(timeZone).toInstant();

export const calendarDraftTimes = (
  draft: CalendarDraft,
  previous?: { start: Temporal.Instant; end: Temporal.Instant },
) => {
  if (!draft.title.trim()) throw new RangeError("Enter a title.");
  if (draft.allDay) {
    const start = calendarDate(draft.start);
    const end = calendarDate(draft.end);
    if (Temporal.PlainDate.compare(end, start) <= 0)
      throw new RangeError("The last day must be on or after the first day.");
    return null;
  }

  const zone = calendarTimeZone(draft.timeZone);
  const inZone = (value: string, old: Temporal.Instant | undefined) => {
    const local = localDateTime(value);
    // Preserve the original instant when editing an event in a repeated hour.
    if (old?.toZonedDateTimeISO(zone).toPlainDateTime().equals(local))
      return old;
    const zoned = local.toZonedDateTime(zone);
    if (!zoned.toPlainDateTime().equals(local))
      throw new RangeError(
        "This time does not exist in the event’s time zone.",
      );
    return zoned.toInstant();
  };
  const start = inZone(draft.start, previous?.start);
  const end = inZone(draft.end, previous?.end);
  if (Temporal.Instant.compare(end, start) < 0)
    throw new RangeError("The end time must be on or after the start time.");
  return { start, end, zone };
};

export const calendarDays = (start: string, amount: number) =>
  calendarDate(start).add({ days: amount }).toString();

export const calendarWeekStart = (date: Temporal.PlainDate) =>
  date.subtract({ days: date.dayOfWeek - 1 }).toString();
