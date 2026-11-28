import * as stylex from "@stylexjs/stylex";
import { controls } from "./tokens.stylex.ts";

// Crease UI Toggle's compact size and pressed state for native buttons.
const styles = stylex.create({
  compact: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minBlockSize: { default: "2rem", "@media (pointer: coarse)": "2.75rem" },
    minInlineSize: { default: "2rem", "@media (pointer: coarse)": "2.75rem" },
    paddingInline: "0.375rem",
    border: 0,
    borderRadius: controls.radius,
    backgroundColor: {
      default: "transparent",
      "@media (hover: hover)": { ":hover": controls.hover },
      '[aria-pressed="true"]': controls.selected,
    },
    color: controls.foreground,
    fontFamily: "inherit",
    fontSize: "0.875rem",
    fontWeight: 500,
    cursor: "pointer",
    outline: { ":focus-visible": `2px solid ${controls.focus}` },
    outlineOffset: { ":focus-visible": -2 },
  },
});

export const compactToggleClassName =
  stylex.props(styles.compact).className ?? "";
