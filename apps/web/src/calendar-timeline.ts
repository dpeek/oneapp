import { Temporal } from "@js-temporal/polyfill";
import type { CalendarOccurrence } from "./calendar-contract.ts";
import { calendarDate } from "./calendar-time.ts";

export const minutesInDay = 24 * 60;
export const slotMinutes = 30;
const slots = Array.from(
  { length: minutesInDay / slotMinutes },
  (_, index) => index * slotMinutes,
);

const wallTime = (day: string, minute: number) =>
  calendarDate(day).toPlainDateTime().add({ minutes: minute });

export const calendarSlots = (day: string, zone: string) => {
  const date = calendarDate(day);
  const start = date.toZonedDateTime(zone);
  const next = date.add({ days: 1 }).toZonedDateTime(zone);
  if (next.epochMilliseconds - start.epochMilliseconds === 86_400_000)
    return slots;
  return slots.filter((minute) => {
    const time = wallTime(day, minute);
    return time.toZonedDateTime(zone).toPlainDateTime().equals(time);
  });
};

export const calendarSlotTimes = (
  day: string,
  minute: number,
  zone: string,
) => ({
  start: wallTime(day, minute).toString({ smallestUnit: "minute" }),
  end: wallTime(day, minute + slotMinutes)
    .toZonedDateTime(zone)
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" }),
});

const wallMinute = (time: Temporal.ZonedDateTime) =>
  time.hour * 60 + time.minute + time.second / 60;

type Segment = {
  event: CalendarOccurrence;
  start: number;
  end: number;
  continues: boolean;
};

const placeEvents = (segments: readonly Segment[]) => {
  let lanes: number[] = [];
  let groupEnd = 0;
  let group = 0;
  const laneCounts: number[] = [];
  const placed = segments.map((segment) => {
    if (segment.start >= groupEnd && lanes.length) {
      group++;
      lanes = [];
    }
    const available = lanes.findIndex((end) => end <= segment.start);
    const lane = available === -1 ? lanes.length : available;
    lanes[lane] = segment.end;
    laneCounts[group] = lanes.length;
    groupEnd = Math.max(groupEnd, segment.end);
    return { ...segment, group, lane };
  });
  return placed.map(({ group, ...item }) => ({
    ...item,
    lanes: laneCounts[group]!,
  }));
};

export const calendarTimelineDay = (
  events: readonly CalendarOccurrence[],
  day: string,
  zone: string,
) => {
  const date = calendarDate(day);
  const from = date.toZonedDateTime(zone).epochMilliseconds;
  const to = date.add({ days: 1 }).toZonedDateTime(zone).epochMilliseconds;
  const allDay: CalendarOccurrence[] = [];
  const segments: Segment[] = [];
  for (const event of events) {
    if (event.allDay) {
      if (event.start <= day && day < event.end) allDay.push(event);
      continue;
    }
    const starts = Temporal.Instant.from(event.start).toZonedDateTimeISO(zone);
    const ends = Temporal.Instant.from(event.end).toZonedDateTimeISO(zone);
    const startMs = starts.epochMilliseconds;
    const endMs = ends.epochMilliseconds;
    if (startMs >= to || endMs < from || (endMs === from && startMs !== endMs))
      continue;
    const start = startMs < from ? 0 : wallMinute(starts);
    const end = endMs >= to ? minutesInDay : wallMinute(ends);
    // Give short events room for a title. Include that space in overlap layout.
    const top = Math.min(start, minutesInDay - slotMinutes);
    segments.push({
      event,
      start: top,
      end: Math.max(top + slotMinutes, end),
      continues: startMs < from,
    });
  }
  segments.sort((a, b) => a.start - b.start || b.end - a.end);
  return {
    allDay,
    timed: placeEvents(segments),
    slots: calendarSlots(day, zone),
  };
};
