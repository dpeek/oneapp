import { expect, it } from "@effect/vitest";
import { defaultCalendarId } from "../calendar-contract.ts";
import {
  calendarOccurrences,
  calendarRange,
  combineCalendarEvents,
  readCalendarImport,
  writeCalendarEvent,
} from "./calendar-ical.ts";

const calendar = (...lines: string[]) =>
  [
    "BEGIN:VCALENDAR",
    "PRODID:-//Orumai test//EN",
    "VERSION:2.0",
    ...lines,
    "END:VCALENDAR",
    "",
  ].join("\r\n");

const event = (uid: string, ...lines: string[]) => [
  "BEGIN:VEVENT",
  `UID:${uid}`,
  "DTSTAMP:20260101T000000Z",
  ...lines,
  "END:VEVENT",
];

const expand = (ics: string, week: string, zone = "Australia/Sydney") =>
  calendarOccurrences(
    {
      id: "event",
      calendar_id: defaultCalendarId,
      revision: "revision",
      ics,
      remind_at: null,
    },
    calendarRange(week, zone),
  );

it("keeps a Sydney series at the same local hour across daylight saving", () => {
  const { events, warnings } = readCalendarImport(
    calendar(
      ...event(
        "weekly",
        "DTSTART;TZID=Australia/Sydney:20260928T090000",
        "DTEND;TZID=Australia/Sydney:20260928T100000",
        "RRULE:FREQ=WEEKLY",
        "SUMMARY:Stand-up",
      ),
    ),
  );
  expect(warnings).toEqual([]);
  expect(expand(events[0]!.ics, "2026-09-28").events).toMatchObject([
    {
      start: "2026-09-27T23:00:00Z",
      end: "2026-09-28T00:00:00Z",
      recurring: true,
      draft: { start: "2026-09-28T09:00:00" },
      series: { repeat: { frequency: "weekly", until: null } },
    },
  ]);
  expect(expand(events[0]!.ics, "2026-10-05").events).toMatchObject([
    { start: "2026-10-04T22:00:00Z", end: "2026-10-04T23:00:00Z" },
  ]);
});

it("uses the date of a moved override and suppresses excluded and cancelled occurrences", () => {
  const source = calendar(
    ...event(
      "weekly",
      "DTSTART;TZID=Australia/Sydney:20261005T090000",
      "RRULE:FREQ=WEEKLY;COUNT=4",
      "EXDATE;TZID=Australia/Sydney:20261012T090000",
      "SUMMARY:Stand-up",
      "LOCATION:Meeting room",
    ),
    ...event(
      "weekly",
      "RECURRENCE-ID:20261025T220000Z",
      "DTSTART;TZID=Australia/Sydney:20261008T110000",
      "SUMMARY:Moved stand-up",
    ),
    ...event(
      "weekly",
      "RECURRENCE-ID;TZID=Australia/Sydney:20261019T090000",
      "STATUS:CANCELLED",
    ),
  );
  const result = readCalendarImport(source);
  expect(result.warnings).toEqual([]);
  const ics = result.events[0]!.ics;
  expect(
    expand(ics, "2026-10-05").events.sort((a, b) =>
      a.start.localeCompare(b.start),
    ),
  ).toMatchObject([
    { title: "Stand-up", start: "2026-10-04T22:00:00Z" },
    {
      title: "Moved stand-up",
      start: "2026-10-08T00:00:00Z",
      occurrence: "2026-10-25T22:00:00Z",
      location: "Meeting room",
      draft: { start: "2026-10-08T11:00:00" },
    },
  ]);
  for (const week of ["2026-10-12", "2026-10-19", "2026-10-26"])
    expect(expand(ics, week).events).toEqual([]);
  expect(expand(ics, "2026-10-05").events[0]!.series).toBeUndefined();
});

const timedDraft = {
  title: "Stand-up",
  description: "",
  location: "Meeting room",
  allDay: false,
  reminder: false,
  timeZone: "Australia/Sydney",
  start: "2026-09-28T09:00",
  end: "2026-09-28T10:00",
};

it("creates a weekly series with an inclusive cutoff and keeps its hour across daylight saving", () => {
  const repeat = { frequency: "weekly", until: "2026-10-12" } as const;
  const { ics, remindAt } = writeCalendarEvent(
    { ...timedDraft, reminder: true },
    "weekly",
    undefined,
    { repeat },
  )!;
  expect(remindAt).toBeNull();
  const occurs = (week: string) => expand(ics, week).events;
  expect(occurs("2026-09-28")).toMatchObject([
    { start: "2026-09-27T23:00:00Z", recurring: true },
  ]);
  expect(occurs("2026-10-05")).toMatchObject([
    {
      start: "2026-10-04T22:00:00Z",
      end: "2026-10-04T23:00:00Z",
      draft: { start: "2026-10-05T09:00:00" },
      series: { draft: { start: "2026-09-28T09:00:00" }, repeat },
    },
  ]);
  expect(occurs("2026-10-12")).toHaveLength(1);
  expect(occurs("2026-10-19")).toEqual([]);
  expect(() =>
    writeCalendarEvent(timedDraft, "weekly", undefined, {
      repeat: { ...repeat, until: "2026-09-27" },
    }),
  ).toThrow("on or after the first day");
});

it("repeats all-day events by day or month without shifting dates across zones", () => {
  const draft = {
    ...timedDraft,
    allDay: true,
    timeZone: "",
    start: "2026-01-31",
    end: "2026-02-01",
  };
  const daily = writeCalendarEvent(draft, "daily", undefined, {
    repeat: { frequency: "daily", until: "2026-02-02" },
  })!.ics;
  expect(expand(daily, "2026-01-30").events.map(({ start }) => start)).toEqual([
    "2026-01-31",
    "2026-02-01",
    "2026-02-02",
  ]);
  const monthly = writeCalendarEvent(draft, "monthly", undefined, {
    repeat: { frequency: "monthly", until: "2026-03-31" },
  })!.ics;
  expect(expand(monthly, "2026-02-23").events).toEqual([]);
  expect(
    expand(monthly, "2026-03-30", "America/Los_Angeles").events,
  ).toMatchObject([{ start: "2026-03-31", end: "2026-04-01", allDay: true }]);
});

it("keeps a moved occurrence and an exclusion when the series time changes", () => {
  const source = readCalendarImport(
    calendar(
      ...event(
        "weekly",
        "DTSTART;TZID=Australia/Sydney:20260928T090000",
        "DTEND;TZID=Australia/Sydney:20260928T100000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO",
        "EXDATE;TZID=Australia/Sydney:20261012T090000",
        "SUMMARY:Stand-up",
        "LOCATION:Meeting room",
      ),
    ),
  ).events[0]!.ics;
  const original = expand(source, "2026-10-05").events[0]!;
  const moved = {
    ...original.draft!,
    start: "2026-10-06T11:00",
    end: "2026-10-06T12:00",
    location: "",
  };
  const { ics } = writeCalendarEvent(moved, "weekly", source, {
    occurrence: original.occurrence,
  })!;
  expect(expand(ics, "2026-10-05").events).toMatchObject([
    {
      occurrence: original.occurrence,
      start: "2026-10-06T00:00:00Z",
      location: "",
      draft: { start: "2026-10-06T11:00:00" },
    },
  ]);
  const changed = writeCalendarEvent(
    {
      ...original.series!.draft,
      title: "Team sync",
      start: "2026-09-28T10:00",
      end: "2026-09-28T11:00",
    },
    "weekly",
    ics,
    { repeat: original.series!.repeat },
  )!.ics;
  const exception = expand(changed, "2026-10-05").events[0]!;
  expect(exception).toMatchObject({
    occurrence: "2026-10-04T23:00:00Z",
    start: "2026-10-06T00:00:00Z",
    title: "Team sync",
    location: "",
  });
  expect(expand(changed, "2026-10-12").events).toEqual([]);
  expect(expand(changed, "2026-10-19").events).toMatchObject([
    { start: "2026-10-18T23:00:00Z", title: "Team sync" },
  ]);
  const edited = writeCalendarEvent(
    { ...exception.draft!, title: "Moved sync" },
    "weekly",
    changed,
    { occurrence: exception.occurrence },
  )!.ics;
  expect(expand(edited, "2026-10-05").events).toMatchObject([
    { title: "Moved sync", occurrence: exception.occurrence },
  ]);
  expect(() =>
    writeCalendarEvent(moved, "weekly", changed, {
      occurrence: original.occurrence,
    }),
  ).toThrow("no longer in the series");
  expect(() =>
    writeCalendarEvent(timedDraft, "weekly", ics, {
      repeat: { frequency: "weekly", until: "2026-09-28" },
    }),
  ).toThrow("would remove individually changed occurrences");
});

it("keeps a multi-day date range in every display zone and exports it with an exclusive end", () => {
  const result = readCalendarImport(
    calendar(
      ...event(
        "holiday",
        "DTSTART;VALUE=DATE:20261003",
        "DTEND;VALUE=DATE:20261006",
        "SUMMARY:Holiday",
      ),
    ),
  );
  const ics = result.events[0]!.ics;
  for (const zone of ["America/Los_Angeles", "Australia/Sydney"]) {
    expect(expand(ics, "2026-10-05", zone).events).toMatchObject([
      {
        title: "Holiday",
        allDay: true,
        start: "2026-10-03",
        end: "2026-10-06",
      },
    ]);
    expect(expand(ics, "2026-10-06", zone).events).toEqual([]);
  }
  expect(combineCalendarEvents([ics])).toContain("DTEND;VALUE=DATE:20261006");
});

it("expands using a time zone embedded in the calendar and preserves it on export", () => {
  const source = calendar(
    "BEGIN:VTIMEZONE",
    "TZID:Custom/Site",
    "BEGIN:STANDARD",
    "DTSTART:20000101T000000",
    "TZOFFSETFROM:+0530",
    "TZOFFSETTO:+0530",
    "END:STANDARD",
    "END:VTIMEZONE",
    ...event(
      "custom",
      "DTSTART;TZID=Custom/Site:20261124T090000",
      "SUMMARY:Custom time zone",
    ),
  );
  const result = readCalendarImport(source);
  expect(result.warnings).toEqual([]);
  const file = result.events[0]!.ics;
  expect(expand(file, "2026-11-23").events).toMatchObject([
    { start: "2026-11-24T03:30:00Z" },
  ]);
  expect(combineCalendarEvents([file])).toContain("TZID:Custom/Site");
});

it("reports unsupported entries and rejects scheduling messages", () => {
  const result = readCalendarImport(
    calendar(
      "BEGIN:VTODO",
      "UID:a-task",
      "END:VTODO",
      ...event(
        "frequent",
        "DTSTART:20261001T010000Z",
        "RRULE:FREQ=SECONDLY",
        "SUMMARY:Frequent",
      ),
      ...event("valid", "DTSTART:20261001T020000Z", "SUMMARY:Valid"),
    ),
  );
  expect(result.total).toBe(3);
  expect(result.events.map(({ uid }) => uid)).toEqual(["valid"]);
  expect(result.warnings).toEqual([
    "Unsupported calendar entry (VTODO).",
    "Frequent: This recurrence frequency is unsupported.",
  ]);
  expect(() => readCalendarImport(calendar("METHOD:REQUEST"))).toThrow(
    "scheduling message",
  );
});

it("preserves the later repeated hour when editing and rejects nonexistent local times", () => {
  const source = readCalendarImport(
    calendar(
      ...event(
        "dst",
        "DTSTART:20260404T163000Z",
        "DTEND:20260404T164500Z",
        "SUMMARY:Repeated hour",
      ),
    ),
  ).events[0]!.ics;
  const draft = {
    title: "Updated",
    description: "",
    location: "",
    allDay: false,
    reminder: true,
    timeZone: "Australia/Sydney",
    start: "2026-04-05T02:30",
    end: "2026-04-05T02:45",
  };
  const next = writeCalendarEvent(draft, "dst", source)!;
  expect(next.ics).toContain("DTSTART:20260404T163000Z");
  expect(next.ics).toContain("TRIGGER:-PT10M");
  expect(next.remindAt).toBe(Date.parse("2026-04-04T16:20:00Z"));
  expect(() =>
    writeCalendarEvent({ ...draft, start: "2026-10-04T02:30" }, "gap"),
  ).toThrow("does not exist");
});

it("includes DTSTART in an RDATE series and honors an exclusion of DTSTART", () => {
  const { events, warnings } = readCalendarImport(
    calendar(
      ...event(
        "rdate",
        "DTSTART:20261124T000000Z",
        "RDATE:20261126T000000Z",
        "SUMMARY:Two days",
      ),
      ...event(
        "excluded",
        "DTSTART:20261124T000000Z",
        "EXDATE:20261124T000000Z",
        "SUMMARY:Excluded",
      ),
    ),
  );
  expect(warnings).toEqual([]);
  expect(
    expand(events[0]!.ics, "2026-11-23").events.map(({ start }) => start),
  ).toEqual(["2026-11-24T00:00:00Z", "2026-11-26T00:00:00Z"]);
  expect(expand(events[1]!.ics, "2026-11-23").events).toEqual([]);
});
