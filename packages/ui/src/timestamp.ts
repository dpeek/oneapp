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
export const timestamp = <Message>(
  value: number,
  now: number,
  h: HtmlBuilder<Message>,
) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return h.empty;
  const elapsed = Math.round((value - now) / 1000);
  const magnitude = Math.abs(elapsed);
  const count = (unit: number) =>
    Math.sign(elapsed) * Math.floor(magnitude / unit);
  let label = absolute.format(date);
  if (magnitude < 10) label = relative.format(0, "second");
  else if (magnitude < 60) label = relative.format(elapsed, "second");
  else if (magnitude < 3600) label = relative.format(count(60), "minute");
  else if (magnitude < 86400) label = relative.format(count(3600), "hour");
  else if (magnitude <= 604800) label = relative.format(count(86400), "day");
  return h.time(
    [
      h.DataAttribute("slot", "timestamp"),
      h.Datetime(date.toISOString()),
      h.Title(exact.format(date)),
      h.Class(stylex.props(styles.time).className ?? ""),
    ],
    [label],
  );
};
