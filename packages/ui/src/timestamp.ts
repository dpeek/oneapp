import * as stylex from "@stylexjs/stylex";
import type { HtmlBuilder } from "foldkit/html";
import { controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  time: {
    color: controls.mutedForeground,
    fontSize: "0.75rem",
    whiteSpace: "nowrap",
  },
});

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const absolute = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const exact = new Intl.DateTimeFormat(undefined, {
  dateStyle: "full",
  timeStyle: "short",
});

// Crease Timestamp's auto format uses relative time within a week.
const relativeTimestamp = (date: Date, now: number) => {
  const elapsed = Math.round((date.getTime() - now) / 1000);
  const magnitude = Math.abs(elapsed);
  const count = (unit: number) =>
    Math.sign(elapsed) * Math.floor(magnitude / unit);
  if (magnitude < 10) return relative.format(0, "second");
  if (magnitude < 60) return relative.format(elapsed, "second");
  if (magnitude < 3600) return relative.format(count(60), "minute");
  if (magnitude < 86400) return relative.format(count(3600), "hour");
  if (magnitude <= 604800) return relative.format(count(86400), "day");
  return absolute.format(date);
};

export const timestamp = <Message>(
  value: number,
  now: number,
  h: HtmlBuilder<Message>,
  format = relativeTimestamp,
) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return h.empty;
  return h.time(
    [
      h.DataAttribute("slot", "timestamp"),
      h.Datetime(date.toISOString()),
      h.Title(exact.format(date)),
      h.Class(stylex.props(styles.time).className ?? ""),
    ],
    [format(date, now)],
  );
};
