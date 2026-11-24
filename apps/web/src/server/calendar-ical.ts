import { Temporal } from "@js-temporal/polyfill";
import ICAL from "ical.js";
import {
  calendarImportLimit,
  calendarReminderMinutes,
  type CalendarDraft,
  type CalendarOccurrence,
  type CalendarRepeat,
} from "../calendar-contract.ts";
import {
  calendarDate,
  calendarDays,
  calendarInstant,
  calendarTimeZone,
  calendarDraftTimes,
} from "../calendar-time.ts";

const oneAppTimeZone = "x-oneapp-timezone";
const oneAppAlarm = "x-oneapp-reminder";
const recurringProperties = ["rrule", "rdate", "exdate"];
const dateProperties = ["dtstart", "dtend", "recurrence-id", "rdate", "exdate"];
const utc = ICAL.Timezone.utcTimezone;
const floating = ICAL.Timezone.localTimezone;
// Each stored series carries its own calendar wrapper and time zones.
const normalizedImportLimit = calendarImportLimit * 4;
const recurrenceExpansionLimit = 25_000;

const newCalendar = () => {
  const calendar = new ICAL.Component("vcalendar");
  calendar.addPropertyWithValue("version", "2.0");
  calendar.addPropertyWithValue("prodid", "-//OneApp//Calendar//EN");
  return calendar;
};

const parseCalendar = (ics: string) => {
  const calendar = new ICAL.Component(ICAL.parse(ics));
  if (calendar.name !== "vcalendar")
    throw new Error(
      "Choose an iCalendar (.ics) file containing a single calendar.",
    );
  return calendar;
};

const withTimeZones = (calendar: ICAL.Component) => {
  const lookup = calendar.getTimeZoneByID.bind(calendar);
  const zones = new Map<string, ICAL.Timezone>();
  // Resolve a missing VTIMEZONE through the runtime's IANA data. Keep the
  // fallback local to this calendar so one import cannot affect another.
  calendar.getTimeZoneByID = (id) => {
    const embedded = lookup(id);
    if (embedded) return embedded;
    const cached = zones.get(id);
    if (cached) return cached;
    const timeZone = calendarTimeZone(id);
    const zone = new ICAL.Timezone({ tzid: id });
    zone.utcOffset = (time) => {
      const local = Temporal.PlainDateTime.from(time.toString());
      const zoned = local.toZonedDateTime(timeZone);
      if (zoned.toPlainDateTime().equals(local))
        return zoned.offsetNanoseconds / 1_000_000_000;
      return (
        (local.toZonedDateTime("UTC").epochMilliseconds -
          zoned.epochMilliseconds) /
        1000
      );
    };
    zones.set(id, zone);
    return zone;
  };
  return calendar;
};

const textProperty = (component: ICAL.Component, key: string) => {
  const value = component.getFirstPropertyValue(key);
  return typeof value === "string" ? value : "";
};

const timeZonesUsed = (events: readonly ICAL.Component[]) =>
  new Set(
    events.flatMap((event) =>
      event.getAllProperties().flatMap((property) => {
        const id = property.getParameter("tzid");
        return typeof id === "string" ? [id] : [];
      }),
    ),
  );

const cancelled = (event: ICAL.Component) =>
  textProperty(event, "status").toUpperCase() === "CANCELLED";

const serialized = (calendar: ICAL.Component) => calendar.toString() + "\r\n";

const seriesFor = (calendar: ICAL.Component) => {
  const members = calendar.getAllSubcomponents("vevent");
  const masters = members.filter(
    (member) => !member.hasProperty("recurrence-id"),
  );
  if (masters.length !== 1)
    throw new Error("Expected one event or recurring series.");
  const master = masters[0]!;
  const exceptions = members.filter((member) => member !== master);
  return {
    master,
    exceptions,
    recurring:
      exceptions.length > 0 ||
      recurringProperties.some((name) => master.hasProperty(name)),
  };
};

const instantFor = (time: ICAL.Time, timeZone: string) =>
  time.zone === floating
    ? calendarInstant(time.toString(), timeZone)
    : Temporal.Instant.fromEpochMilliseconds(time.toUnixTime() * 1000);

const keyFor = (time: ICAL.Time, timeZone: string) =>
  time.isDate ? time.toString() : instantFor(time, timeZone).toString();

// Floating recurrences use their wall time as their identity on every device.
const occurrenceKey = (time: ICAL.Time) =>
  time.zone === floating ? time.toString() : keyFor(time, "UTC");

const recurrenceExclusions = (event: ICAL.Event) =>
  event.component
    .getAllProperties("exdate")
    .flatMap((property) =>
      property
        .getValues()
        .filter((value): value is ICAL.Time => value instanceof ICAL.Time),
    );

const validateSeries = (calendar: ICAL.Component) => {
  const { master, exceptions, recurring } = seriesFor(calendar);
  const event = new ICAL.Event(master, { exceptions: [] });
  if (calendar.getFirstPropertyValue("method") || master.hasProperty("exrule"))
    throw new Error("Scheduling messages and EXRULE are unsupported.");
  const ruleProperties = master.getAllProperties("rrule");
  if (ruleProperties.length > 1) throw new Error("Multiple recurrence rules.");
  for (const property of ruleProperties) {
    const rule = property.getFirstValue();
    if (
      !(rule instanceof ICAL.Recur) ||
      !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(rule.freq ?? "") ||
      rule.interval < 1 ||
      rule.interval > 366 ||
      ["BYHOUR", "BYMINUTE", "BYSECOND"].some((part) => part in rule.parts)
    ) {
      throw new Error("This recurrence frequency is unsupported.");
    }
  }
  const seenExceptions = new Set<string>();
  for (const component of [master, ...exceptions]) {
    for (const name of dateProperties) {
      for (const property of component.getAllProperties(name)) {
        for (const time of property.getValues()) {
          if (!(time instanceof ICAL.Time))
            throw new Error("This date or recurrence period is unsupported.");
          keyFor(time, "UTC");
        }
      }
    }
    if (component !== master) {
      const recurrence = component.getFirstProperty("recurrence-id")!;
      if (recurrence.getParameter("range"))
        throw new Error(
          "Changes to this and future occurrences are unsupported.",
        );
      const time = recurrence.getFirstValue() as ICAL.Time;
      if (!event.startDate || time.isDate !== event.startDate.isDate)
        throw new Error("The exception date does not match the series.");
      const key = keyFor(time, "UTC");
      if (seenExceptions.has(key))
        throw new Error("Duplicate recurrence exception.");
      seenExceptions.add(key);
      if (cancelled(component) && !component.hasProperty("dtstart")) continue;
    }
    const item = new ICAL.Event(component, { exceptions: [] });
    if (!item.startDate || item.startDate.isDate !== item.endDate.isDate)
      throw new Error("The event dates are invalid.");
    const start = keyFor(item.startDate, "UTC");
    const end = keyFor(item.endDate, "UTC");
    if (end < start || (item.startDate.isDate && end === start))
      throw new Error("The event dates are invalid.");
  }
  if (recurring && !cancelled(master)) event.iterator().next();
};

const eventDays = (event: ICAL.Event, recurring: boolean) =>
  recurring
    ? { firstDay: null, lastDay: null }
    : {
        firstDay: keyFor(event.startDate, "UTC").slice(0, 10),
        lastDay: keyFor(event.endDate, "UTC").slice(0, 10),
      };

type ImportedEvent = { uid: string; ics: string } & ReturnType<
  typeof eventDays
>;

export const readCalendarImport = (ics: string) => {
  const calendar = parseCalendar(ics);
  if (
    calendar.hasProperty("method") &&
    textProperty(calendar, "method").toUpperCase() !== "PUBLISH"
  )
    throw new Error(
      "Export a calendar file. This file is a scheduling message.",
    );

  const groups = new Map<string, ICAL.Component[]>();
  const warnings: string[] = [];
  let invalid = 0;
  for (const member of calendar.getAllSubcomponents()) {
    if (member.name === "vtimezone") continue;
    if (member.name !== "vevent") {
      invalid++;
      warnings.push(
        `Unsupported calendar entry (${member.name.toUpperCase()}).`,
      );
      continue;
    }
    const uid = textProperty(member, "uid");
    if (!uid || uid.length > 1000) {
      invalid++;
      warnings.push(
        `${textProperty(member, "summary").slice(0, 120) || "Event"}: missing or invalid UID.`,
      );
      continue;
    }
    const group = groups.get(uid);
    if (group) group.push(member);
    else groups.set(uid, [member]);
  }
  if (groups.size > 2000)
    throw new Error("Choose an export with at most 2,000 events and series.");

  const events: ImportedEvent[] = [];
  let normalizedBytes = 0;
  const encoder = new TextEncoder();
  for (const [uid, members] of groups) {
    try {
      const single = withTimeZones(newCalendar());
      const used = timeZonesUsed(members);
      for (const zone of calendar.getAllSubcomponents("vtimezone")) {
        if (used.has(textProperty(zone, "tzid")))
          single.addSubcomponent(new ICAL.Component(zone.toJSON()));
      }
      for (const member of members)
        single.addSubcomponent(new ICAL.Component(member.toJSON()));
      validateSeries(single);
      const file = serialized(single);
      normalizedBytes += encoder.encode(file).byteLength;
      if (normalizedBytes <= normalizedImportLimit) {
        const { master, recurring } = seriesFor(single);
        events.push({
          uid,
          ics: file,
          ...eventDays(new ICAL.Event(master, { exceptions: [] }), recurring),
        });
      }
    } catch (error) {
      const title = members
        .map((member) => textProperty(member, "summary"))
        .find(Boolean);
      warnings.push(
        `${title?.slice(0, 120) || "Event"}: ${error instanceof Error && error.message.length < 120 ? error.message : "could not read this event."}`,
      );
    }
  }
  if (normalizedBytes > normalizedImportLimit)
    throw new Error(
      "This calendar is too large after expanding its time zone definitions.",
    );
  const total = groups.size + invalid;
  return { events, total, warnings: warnings.slice(0, 50) };
};

export const combineCalendarEvents = (
  files: readonly string[],
  name?: string,
) => {
  const calendar = newCalendar();
  if (name) {
    const property = calendar.addPropertyWithValue("x-wr-calname", name);
    property.resetType("text");
    property.setValue(name);
  }
  const definitions = new Map<string, Map<string, string>>();
  for (const file of files) {
    const source = parseCalendar(file);
    const names = new Map<string, string>();
    for (const zone of source.getAllSubcomponents("vtimezone")) {
      const id = textProperty(zone, "tzid");
      const key = zone.toString();
      const variants = definitions.get(id) ?? new Map<string, string>();
      definitions.set(id, variants);
      const existing = variants.get(key);
      if (existing) {
        names.set(id, existing);
        continue;
      }
      const name = variants.size === 0 ? id : `OneApp/${crypto.randomUUID()}`;
      variants.set(key, name);
      names.set(id, name);
      zone.updatePropertyWithValue("tzid", name);
      calendar.addSubcomponent(zone);
    }
    for (const event of source.getAllSubcomponents("vevent")) {
      for (const property of event.getAllProperties()) {
        const id = property.getParameter("tzid");
        if (typeof id === "string") {
          const name = names.get(id);
          if (name && name !== id) property.setParameter("tzid", name);
        }
      }
      calendar.addSubcomponent(event);
    }
  }
  return serialized(calendar);
};

const editable = (component: ICAL.Component) =>
  !component.hasProperty("organizer") &&
  !component.hasProperty("attendee") &&
  !cancelled(component);

export const canDeleteCalendarEvent = (ics: string) => {
  const { master, recurring } = seriesFor(parseCalendar(ics));
  return !recurring && editable(master);
};

const eventFields = (event: ICAL.Event, master = event) => {
  const field = (key: string) =>
    textProperty(
      event.component.hasProperty(key) ? event.component : master.component,
      key,
    );
  return {
    title:
      textProperty(event.component, "summary") ||
      textProperty(master.component, "summary") ||
      "Untitled event",
    location: field("location"),
    description: field("description"),
  };
};

const repeatFor = (event: ICAL.Event): CalendarRepeat | null => {
  const rule = event.component.getFirstPropertyValue("rrule");
  const start = event.startDate;
  if (
    !(rule instanceof ICAL.Recur) ||
    rule.interval !== 1 ||
    rule.count ||
    event.component.hasProperty("rdate") ||
    (!start.isDate && start.zone === floating)
  )
    return null;
  const frequency = rule.freq?.toLowerCase();
  if (
    frequency !== "daily" &&
    frequency !== "weekly" &&
    frequency !== "monthly"
  )
    return null;
  const parts = Object.keys(rule.parts);
  if (parts.length) {
    const weekdays = rule.getComponent("BYDAY");
    if (
      frequency !== "weekly" ||
      parts.length !== 1 ||
      weekdays.length !== 1 ||
      weekdays[0] !== ICAL.Recur.numericDayToIcalDay(start.dayOfWeek())
    )
      return null;
  }
  let zone = "UTC";
  if (!start.isDate) {
    try {
      zone = calendarTimeZone(start.zone.tzid);
    } catch {
      return null;
    }
  }
  const until = rule.until?.isDate
    ? rule.until.toString()
    : rule.until
      ? instantFor(rule.until, zone)
          .toZonedDateTimeISO(zone)
          .toPlainDate()
          .toString()
      : null;
  return { frequency, until };
};

const utcTime = (instant: Temporal.Instant) =>
  ICAL.Time.fromJSDate(new Date(instant.epochMilliseconds), true);

const localTime = (
  instant: Temporal.Instant,
  zone: string,
  calendar: ICAL.Component,
) => {
  if (zone === "UTC") return utcTime(instant);
  const local = instant.toZonedDateTimeISO(zone).toPlainDateTime();
  const time = ICAL.Time.fromDateTimeString(
    local.toString({ smallestUnit: "second" }),
  );
  time.zone = calendar.getTimeZoneByID(zone);
  return time;
};

const recurrenceRule = (
  repeat: CalendarRepeat,
  start: ICAL.Time,
  zone: string,
) => {
  const until = repeat.until === null ? null : calendarDate(repeat.until);
  if (until && until.toString() < start.toString().slice(0, 10))
    throw new RangeError(
      "The last day to repeat must be on or after the first day.",
    );
  return ICAL.Recur.fromData({
    freq: repeat.frequency.toUpperCase(),
    ...(until
      ? {
          until: start.isDate
            ? ICAL.Time.fromDateString(until.toString())
            : utcTime(
                until
                  .add({ days: 1 })
                  .toZonedDateTime(zone)
                  .toInstant()
                  .subtract({ seconds: 1 }),
              ),
        }
      : {}),
  });
};

const findOccurrence = (event: ICAL.Event, key: string) => {
  if (recurrenceExclusions(event).some((value) => occurrenceKey(value) === key))
    return null;
  if (occurrenceKey(event.startDate) === key) return event.startDate;
  const iterator = event.iterator();
  for (let count = 0; count < recurrenceExpansionLimit; count++) {
    const time = iterator.next();
    if (!time) break;
    const candidate = occurrenceKey(time);
    if (candidate === key) return time;
    if (candidate > key) break;
  }
  return null;
};

const recurrenceEnd = (event: ICAL.Event, timeZone: string) => {
  if (!event.startDate.isDate && event.component.hasProperty("dtend")) {
    const milliseconds =
      instantFor(event.endDate, timeZone).epochMilliseconds -
      instantFor(event.startDate, timeZone).epochMilliseconds;
    return (time: ICAL.Time) =>
      instantFor(time, timeZone).add({ milliseconds }).toString();
  }
  const duration = event.duration;
  return (time: ICAL.Time) => {
    const end = time.clone();
    end.addDuration(duration);
    return keyFor(end, timeZone);
  };
};

// Keep individual changes attached to their original calendar dates when
// the rule or time changes. Reject a schedule that would orphan them.
const keepRecurrenceExceptions = (
  master: ICAL.Event,
  originalStart: ICAL.Time,
  overrides: readonly ICAL.Event[],
  exclusions: readonly ICAL.Time[],
) => {
  if (!overrides.length && !exclusions.length) return;
  if (!master.isRecurring())
    throw new RangeError(
      "This series has individual changes. Keep it repeating to preserve them.",
    );
  const originalDate = (time: ICAL.Time) =>
    time.isDate || time.zone === originalStart.zone
      ? time.toString().slice(0, 10)
      : instantFor(time, originalStart.zone.tzid)
          .toZonedDateTimeISO(originalStart.zone.tzid)
          .toPlainDate()
          .toString();
  const dates = new Set([
    ...overrides.map((item) => originalDate(item.recurrenceId)),
    ...exclusions.map(originalDate),
  ]);
  const last = Array.from(dates).sort().at(-1)!;
  const slots = new Map<string, ICAL.Time>();
  const track = (time: ICAL.Time) => {
    const day = time.toString().slice(0, 10);
    if (dates.has(day)) slots.set(day, time.clone());
    return day;
  };
  track(master.startDate);
  const iterator = master.iterator();
  for (
    let count = 0;
    count < recurrenceExpansionLimit && slots.size < dates.size;
    count++
  ) {
    const time = iterator.next();
    if (!time || track(time) > last) break;
  }
  if (slots.size !== dates.size)
    throw new RangeError(
      "This schedule would remove individually changed occurrences. Keep those dates in the series.",
    );
  for (const item of overrides)
    item.recurrenceId = slots.get(originalDate(item.recurrenceId))!;
  for (const time of exclusions) {
    const replacement = slots.get(originalDate(time))!;
    const property = master.component.addPropertyWithValue(
      "exdate",
      replacement,
    );
    if (
      !replacement.isDate &&
      replacement.zone !== utc &&
      replacement.zone !== floating
    )
      property.setParameter("tzid", replacement.zone.tzid);
  }
};

type RecurrenceWrite = { repeat?: CalendarRepeat | null; occurrence?: string };

export const writeCalendarEvent = (
  draft: CalendarDraft,
  uid: string,
  previous?: string,
  options: RecurrenceWrite = {},
) => {
  const calendar = withTimeZones(
    previous ? parseCalendar(previous) : newCalendar(),
  );
  const series = previous ? seriesFor(calendar) : undefined;
  if (series && !editable(series.master)) return null;
  const master = new ICAL.Event(series?.master, { exceptions: [] });
  const { repeat, occurrence } = options;
  let event = master;
  let originalSlot: ICAL.Time | null = null;
  if (occurrence !== undefined) {
    if (!series?.recurring || repeat) return null;
    const override = series.exceptions.find((component) => {
      const id = component.getFirstPropertyValue("recurrence-id");
      return id instanceof ICAL.Time && occurrenceKey(id) === occurrence;
    });
    if (override && !editable(override)) return null;
    event = new ICAL.Event(override, { exceptions: [] });
    originalSlot = override
      ? event.recurrenceId
      : findOccurrence(master, occurrence);
    if (!originalSlot)
      throw new RangeError("This occurrence is no longer in the series.");
    if (!override) {
      calendar.addSubcomponent(event.component);
      event.recurrenceId = originalSlot;
    }
  } else if (
    series?.recurring &&
    (repeat === undefined || !repeatFor(master))
  ) {
    return null;
  }

  const previousStart = event.startDate;
  let before: Parameters<typeof calendarDraftTimes>[1];
  if (!draft.allDay && previousStart && !previousStart.isDate) {
    before = {
      start: instantFor(previousStart, draft.timeZone),
      end: instantFor(event.endDate, draft.timeZone),
    };
  } else if (
    !draft.allDay &&
    !previousStart &&
    originalSlot &&
    !originalSlot.isDate
  ) {
    const end = recurrenceEnd(master, draft.timeZone);
    before = {
      start: instantFor(originalSlot, draft.timeZone),
      end: Temporal.Instant.from(end(originalSlot)),
    };
  }
  const times = calendarDraftTimes(draft, before);
  const previousRepeat =
    previous && event === master && series?.recurring
      ? repeatFor(master)
      : null;
  const overrides =
    event === master
      ? (series?.exceptions ?? []).map((component) => new ICAL.Event(component))
      : [];
  const exclusions = event === master ? recurrenceExclusions(event) : [];
  if (!series) calendar.addSubcomponent(event.component);

  event.uid = uid;
  const base = event !== master ? eventFields(master) : null;
  const fields = {
    summary: [draft.title.trim(), base?.title],
    location: [draft.location.trim(), base?.location],
    description: [draft.description, base?.description],
  } as const;
  for (const [key, [value, inherited]] of Object.entries(fields)) {
    if (value === inherited) event.component.removeProperty(key);
    else event.component.updatePropertyWithValue(key, value);
  }
  event.component.updatePropertyWithValue(
    "dtstamp",
    ICAL.Time.fromJSDate(new Date(), true),
  );
  event.component.removeProperty(oneAppTimeZone);
  for (const alarm of event.component.getAllSubcomponents("valarm"))
    if (alarm.hasProperty(oneAppAlarm))
      event.component.removeSubcomponent(alarm);

  if (!times) {
    event.startDate = ICAL.Time.fromDateString(draft.start);
    event.endDate = ICAL.Time.fromDateString(draft.end);
  } else {
    // A series repeats at its local wall time, including after a clock change.
    event.startDate = repeat
      ? localTime(times.start, times.zone, calendar)
      : utcTime(times.start);
    event.endDate = repeat
      ? localTime(times.end, times.zone, calendar)
      : utcTime(times.end);
    event.component.addPropertyWithValue(oneAppTimeZone, times.zone);
  }

  if (event === master) {
    const sameStart =
      previousStart &&
      occurrenceKey(previousStart) === occurrenceKey(event.startDate) &&
      previousStart.zone.tzid === event.startDate.zone.tzid;
    const sameRepeat =
      previousRepeat &&
      repeat &&
      previousRepeat.frequency === repeat.frequency &&
      previousRepeat.until === repeat.until;
    if (!(sameStart && sameRepeat)) {
      event.component.removeProperty("rrule");
      if (repeat)
        event.component.addPropertyWithValue(
          "rrule",
          recurrenceRule(repeat, event.startDate, times?.zone ?? "UTC"),
        );
      if (previousStart) {
        event.component.removeAllProperties("exdate");
        keepRecurrenceExceptions(event, previousStart, overrides, exclusions);
      }
    }
  }
  const recurring = Boolean(repeat || originalSlot);
  const reminderEndsAt =
    times && draft.reminder && !recurring
      ? times.start.epochMilliseconds
      : null;
  if (reminderEndsAt !== null) {
    const alarm = new ICAL.Component("valarm");
    alarm.addPropertyWithValue("action", "DISPLAY");
    alarm.addPropertyWithValue("description", event.summary);
    alarm.addPropertyWithValue(
      "trigger",
      ICAL.Duration.fromString(`-PT${calendarReminderMinutes}M`),
    );
    alarm.addPropertyWithValue(oneAppAlarm, "TRUE");
    event.component.addSubcomponent(alarm);
  }
  return {
    ics: serialized(calendar),
    ...eventDays(master, recurring),
    remindAt:
      reminderEndsAt === null
        ? null
        : reminderEndsAt - calendarReminderMinutes * 60_000,
    reminderEndsAt,
  };
};

export type CalendarEventRow = {
  id: string;
  calendar_id: string;
  revision: string;
  ics: string;
  remind_at: number | null;
};

export const calendarRange = (start: string, timeZone: string) => {
  const end = calendarDays(start, 7);
  return {
    start,
    end,
    timeZone,
    from: calendarDate(start).toZonedDateTime(timeZone).toInstant().toString(),
    to: calendarDate(end).toZonedDateTime(timeZone).toInstant().toString(),
  };
};

type CalendarRange = ReturnType<typeof calendarRange>;

const draftFor = (
  event: ICAL.Event,
  fields: ReturnType<typeof eventFields>,
  start: string,
  end: string,
  timeZone: string,
  reminder: boolean,
): CalendarDraft | null => {
  const date = event.startDate;
  let zone = "";
  if (!date.isDate) {
    try {
      zone = calendarTimeZone(
        textProperty(event.component, oneAppTimeZone) ||
          (date.zone === floating ? timeZone : date.zone.tzid),
      );
    } catch {
      zone = "UTC";
    }
  }
  const toInput = (value: string) =>
    date.isDate
      ? value
      : Temporal.Instant.from(value)
          .toZonedDateTimeISO(zone)
          .toPlainDateTime()
          .toString({ smallestUnit: "second" });
  if (
    fields.title.length > 250 ||
    fields.location.length > 500 ||
    fields.description.length > 8000
  )
    return null;
  return {
    ...fields,
    allDay: date.isDate,
    start: toInput(start),
    end: toInput(end),
    timeZone: zone,
    reminder,
  };
};

export const calendarOccurrences = (
  row: CalendarEventRow,
  range: CalendarRange,
) => {
  const { timeZone } = range;
  const { master, exceptions, recurring } = seriesFor(
    withTimeZones(parseCalendar(row.ics)),
  );
  const events: CalendarOccurrence[] = [];
  if (cancelled(master)) return { events, incomplete: false };

  const intersects = (start: string, end: string, allDay: boolean) => {
    const from = allDay ? range.start : range.from;
    const to = allDay ? range.end : range.to;
    return start < to && (end > from || (start === end && start >= from));
  };
  const event = new ICAL.Event(master, { exceptions: [] });
  const repeat = recurring && editable(master) ? repeatFor(event) : null;
  const seriesDraft = repeat
    ? draftFor(
        event,
        eventFields(event),
        keyFor(event.startDate, timeZone),
        keyFor(event.endDate, timeZone),
        timeZone,
        false,
      )
    : null;
  const add = (
    item: ICAL.Event,
    start: string,
    end: string,
    occurrence: string,
  ) => {
    const allDay = item.startDate.isDate;
    if (!intersects(start, end, allDay)) return;
    const fields = eventFields(item, event);
    events.push({
      id: row.id,
      calendarId: row.calendar_id,
      occurrence,
      ...fields,
      allDay,
      start,
      end,
      recurring,
      draft:
        editable(master) && editable(item.component)
          ? draftFor(
              item,
              fields,
              start,
              end,
              timeZone,
              !recurring && row.remind_at !== null,
            )
          : null,
      ...(repeat && seriesDraft && editable(item.component)
        ? { series: { draft: seriesDraft, repeat } }
        : {}),
      revision: row.revision,
    });
  };
  const addItem = (item: ICAL.Event, occurrence: string) =>
    add(
      item,
      keyFor(item.startDate, timeZone),
      keyFor(item.endDate, timeZone),
      occurrence,
    );
  if (!recurring) {
    addItem(event, keyFor(event.startDate, timeZone));
    return { events, incomplete: false };
  }

  const overrides = new Set<string>();
  for (const component of exceptions) {
    const item = new ICAL.Event(component);
    const key = occurrenceKey(item.recurrenceId);
    overrides.add(key);
    if (!cancelled(component)) addItem(item, key);
  }

  const allDay = event.startDate.isDate;
  const endOf = recurrenceEnd(event, timeZone);
  const iterator = event.iterator();
  const seen = new Set(overrides);
  for (const date of recurrenceExclusions(event)) seen.add(occurrenceKey(date));

  // DTSTART belongs to the recurrence set even in a series built from RDATE.
  const first = occurrenceKey(event.startDate);
  if (!seen.has(first)) addItem(event, first);
  seen.add(first);

  for (let count = 0; count < recurrenceExpansionLimit; count++) {
    const time = iterator.next();
    if (!time) return { events, incomplete: false };
    const start = keyFor(time, timeZone);
    if (start >= (allDay ? range.end : range.to))
      return { events, incomplete: false };
    const key = time.zone === floating ? time.toString() : start;
    if (seen.has(key)) continue;
    seen.add(key);
    add(event, start, endOf(time), key);
  }
  return { events, incomplete: true };
};
