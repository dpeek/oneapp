import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";
import { controls } from "./tokens.stylex.ts";

const spin = stylex.keyframes({ to: { transform: "rotate(360deg)" } });

const styles = stylex.create({
  icon: {
    display: "block",
    color: controls.mutedForeground,
    animationName: {
      default: spin,
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    animationDuration: "0.75s",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },
  label: {
    position: "absolute",
    inlineSize: 1,
    blockSize: 1,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
});

export const spinner = <Message>(
  label: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [h.Role("status"), h.DataAttribute("slot", "spinner")],
    [
      h.svg(
        [
          h.Class(stylex.props(styles.icon).className ?? ""),
          h.ViewBox("0 0 24 24"),
          h.Width("24"),
          h.Height("24"),
          h.Fill("none"),
          h.Stroke("currentColor"),
          h.StrokeWidth("2"),
          h.StrokeLinecap("round"),
          h.AriaHidden(true),
        ],
        [h.path([h.D("M21 12a9 9 0 1 1-9-9")], [])],
      ),
      h.span([h.Class(stylex.props(styles.label).className ?? "")], [label]),
    ],
  );
