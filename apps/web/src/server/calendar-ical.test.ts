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
    "PRODID:-//OneApp test//EN",
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
      draft: null,
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
    },
  ]);
  for (const week of ["2026-10-12", "2026-10-19", "2026-10-26"])
    expect(expand(ics, week).events).toEqual([]);
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
