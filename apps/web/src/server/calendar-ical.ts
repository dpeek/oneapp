import { Temporal } from "@js-temporal/polyfill";
import ICAL from "ical.js";
import {
  calendarReminderMinutes,
  type CalendarDraft,
  type CalendarOccurrence,
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
      if (normalizedBytes <= 2 * 1024 * 1024) {
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
  if (normalizedBytes > 2 * 1024 * 1024)
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

const editable = (component: ICAL.Component, recurring: boolean) =>
  !recurring &&
  !component.hasProperty("organizer") &&
  !component.hasProperty("attendee") &&
  !cancelled(component);

export const canEditCalendarEvent = (ics: string) => {
  const { master, recurring } = seriesFor(parseCalendar(ics));
  return editable(master, recurring);
};

export const writeCalendarEvent = (
  draft: CalendarDraft,
  uid: string,
  previous?: string,
) => {
  const calendar = previous
    ? withTimeZones(parseCalendar(previous))
    : newCalendar();
  const series = previous ? seriesFor(calendar) : undefined;
  if (series && !editable(series.master, series.recurring)) return null;
  const event = new ICAL.Event(series?.master, { exceptions: [] });
  const before =
    series && !event.startDate.isDate && !draft.allDay
      ? {
          start: instantFor(event.startDate, draft.timeZone),
          end: instantFor(event.endDate, draft.timeZone),
        }
      : undefined;
  const times = calendarDraftTimes(draft, before);
  if (!series) calendar.addSubcomponent(event.component);
  event.uid = uid;
  event.summary = draft.title.trim();
  event.location = draft.location.trim();
  event.description = draft.description;
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
    event.startDate = ICAL.Time.fromJSDate(
      new Date(times.start.epochMilliseconds),
      true,
    );
    event.endDate = ICAL.Time.fromJSDate(
      new Date(times.end.epochMilliseconds),
      true,
    );
    event.component.addPropertyWithValue(oneAppTimeZone, times.zone);
    if (draft.reminder) {
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
  }
  const reminderEndsAt =
    times && draft.reminder ? times.start.epochMilliseconds : null;
  return {
    ics: serialized(calendar),
    ...eventDays(event, false),
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
  timeZone: string,
  reminder: boolean,
): CalendarDraft | null => {
  const start = event.startDate;
  const end = event.endDate;
  let zone = "";
  if (!start.isDate) {
    try {
      zone = calendarTimeZone(
        textProperty(event.component, oneAppTimeZone) ||
          (start.zone === floating ? timeZone : start.zone.tzid),
      );
    } catch {
      zone = "UTC";
    }
  }
  const toInput = (time: ICAL.Time) =>
    time.isDate
      ? time.toString()
      : instantFor(time, timeZone)
          .toZonedDateTimeISO(zone)
          .toPlainDateTime()
          .toString({ smallestUnit: "second" });
  const draft = {
    title: event.summary || "Untitled event",
    location: event.location || "",
    description: event.description || "",
    allDay: start.isDate,
    start: toInput(start),
    end: toInput(end),
    timeZone: zone,
    reminder,
  };
  return draft.title.length > 250 ||
    draft.location.length > 500 ||
    draft.description.length > 8000
    ? null
    : draft;
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
  const add = (
    item: ICAL.Event,
    start: string,
    end: string,
    occurrence: string,
  ) => {
    const allDay = item.startDate.isDate;
    if (!intersects(start, end, allDay)) return;
    events.push({
      id: row.id,
      calendarId: row.calendar_id,
      occurrence,
      title: item.summary || event.summary || "Untitled event",
      location:
        textProperty(item.component, "location") ||
        (!item.component.hasProperty("location") ? event.location || "" : ""),
      description:
        textProperty(item.component, "description") ||
        (!item.component.hasProperty("description")
          ? event.description || ""
          : ""),
      allDay,
      start,
      end,
      recurring,
      draft: editable(master, recurring)
        ? draftFor(event, timeZone, row.remind_at !== null)
        : null,
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
    const key = keyFor(item.recurrenceId, timeZone);
    overrides.add(key);
    if (!cancelled(component)) addItem(item, key);
  }

  const allDay = event.startDate.isDate;
  const exactDuration =
    !allDay && master.hasProperty("dtend")
      ? instantFor(event.endDate, timeZone).epochMilliseconds -
        instantFor(event.startDate, timeZone).epochMilliseconds
      : null;
  const duration = exactDuration === null ? event.duration : null;
  const iterator = event.iterator();
  const seen = new Set(overrides);
  for (const property of master.getAllProperties("exdate"))
    for (const date of property.getValues())
      if (date instanceof ICAL.Time) seen.add(keyFor(date, timeZone));

  // DTSTART belongs to the recurrence set even in a series built from RDATE.
  const first = keyFor(event.startDate, timeZone);
  if (!seen.has(first)) addItem(event, first);
  seen.add(first);

  for (let count = 0; count < 25_000; count++) {
    const time = iterator.next();
    if (!time) return { events, incomplete: false };
    const start = keyFor(time, timeZone);
    if (start >= (allDay ? range.end : range.to))
      return { events, incomplete: false };
    if (seen.has(start)) continue;
    seen.add(start);
    let end: string;
    if (exactDuration !== null) {
      end = instantFor(time, timeZone)
        .add({ milliseconds: exactDuration })
        .toString();
    } else {
      const after = time.clone();
      after.addDuration(duration!);
      end = keyFor(after, timeZone);
    }
    add(event, start, end, start);
  }
  return { events, incomplete: true };
};
