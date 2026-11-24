import { expect, it } from "@effect/vitest";
import {
  defaultCalendarId,
  type CalendarOccurrence,
} from "./calendar-contract.ts";
import {
  calendarSlots,
  calendarSlotTimes,
  calendarTimelineDay,
} from "./calendar-timeline.ts";

const zone = "Australia/Sydney";

const event = (
  id: string,
  start: string,
  end: string,
  allDay = false,
): CalendarOccurrence => ({
  id,
  calendarId: defaultCalendarId,
  title: id,
  location: "",
  description: "",
  occurrence: start,
  recurring: false,
  revision: "revision",
  draft: null,
  start,
  end,
  allDay,
});

it("lays out overlapping events in lanes and lets later events use the whole day column", () => {
  const day = calendarTimelineDay(
    [
      event("First", "2026-11-23T22:00:00Z", "2026-11-23T23:30:00Z"),
      event("Overlap", "2026-11-23T22:30:00Z", "2026-11-24T00:00:00Z"),
      event("Later", "2026-11-24T02:00:00Z", "2026-11-24T03:00:00Z"),
    ],
    "2026-11-24",
    zone,
  );
  expect(day.timed).toMatchObject([
    { start: 540, end: 630, lane: 0, lanes: 2 },
    { start: 570, end: 660, lane: 1, lanes: 2 },
    { start: 780, end: 840, lane: 0, lanes: 1 },
  ]);
});

it("clips overnight events to the visible day and respects exclusive all-day ends", () => {
  const events = [
    event("Overnight", "2026-11-24T12:00:00Z", "2026-11-24T14:30:00Z"),
    event("Ends at midnight", "2026-11-24T12:00:00Z", "2026-11-24T13:00:00Z"),
    event("Offsite", "2026-11-24", "2026-11-25", true),
  ];
  const first = calendarTimelineDay(events, "2026-11-24", zone);
  expect(first.allDay.map(({ id }) => id)).toEqual(["Offsite"]);
  expect(first.timed).toMatchObject([
    { start: 1380, end: 1440, continues: false },
    { start: 1380, end: 1440, continues: false },
  ]);
  const second = calendarTimelineDay(events, "2026-11-25", zone);
  expect(second.allDay).toEqual([]);
  expect(second.timed).toMatchObject([
    { event: { id: "Overnight" }, start: 0, end: 90, continues: true },
  ]);
});

it("offers valid creation times across the clock change and midnight", () => {
  const gap = "2026-10-04";
  expect(calendarSlots(gap, zone)).toHaveLength(46);
  expect(calendarSlots(gap, zone)).not.toContain(120);
  expect(calendarSlotTimes(gap, 90, zone)).toEqual({
    start: "2026-10-04T01:30",
    end: "2026-10-04T03:00",
  });
  expect(calendarSlotTimes(gap, 1410, zone)).toEqual({
    start: "2026-10-04T23:30",
    end: "2026-10-05T00:00",
  });
});
