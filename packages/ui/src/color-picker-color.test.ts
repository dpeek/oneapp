import { expect, it } from "@effect/vitest";
import { formatColor, parseColor } from "./color-picker-color.ts";

it.each([
  ["#ABC", "#aabbcc"],
  ["#4B43AD", "#4b43ad"],
  ["rgb(0 128 255)", "#0080ff"],
  ["rgb(100%, 25%, 0%)", "#ff4000"],
  ["hsl(120, 100%, 50%)", "#00ff00"],
  ["hsb(240, 100%, 100%)", "#0000ff"],
])("converts %s to an opaque hex value", (input, expected) => {
  const color = parseColor(input);
  expect(color && formatColor(color, "hex")).toBe(expected);
});

it.each(["#f008", "#ff000080", "rgba(255, 0, 0, 1)", "hsl(0 100% 50% / 40%)"])(
  "rejects a colour with an alpha channel (%s)",
  (input) => expect(parseColor(input)).toBeNull(),
);
