import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";
import { controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  separator: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    "::before": {
      content: '""',
      flex: "1 1 0%",
      blockSize: "1px",
      backgroundColor: controls.border,
    },
    "::after": {
      content: '""',
      flex: "1 1 0%",
      blockSize: "1px",
      backgroundColor: controls.border,
    },
  },
  trigger: {
    minBlockSize: "2rem",
    minInlineSize: 0,
    borderStyle: "none",
    borderRadius: controls.radius,
    padding: 0,
    backgroundColor: "transparent",
    color: {
      default: controls.mutedForeground,
      "@media (hover: hover)": { ":hover": controls.foreground },
    },
    fontFamily: "inherit",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    cursor: "pointer",
    outline: { ":focus-visible": `2px solid ${controls.focus}` },
    outlineOffset: { ":focus-visible": 2 },
  },
});

export const marker = <Message>(
  props: Readonly<{ label: string; onClick: Message }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.DataAttribute("slot", "marker"),
      h.DataAttribute("variant", "separator"),
      h.Class(stylex.props(styles.separator).className ?? ""),
    ],
    [
      h.button(
        [
          h.Type("button"),
          h.DataAttribute("slot", "button"),
          h.Class(stylex.props(styles.trigger).className ?? ""),
          h.OnClick(props.onClick),
        ],
        [props.label],
      ),
    ],
  );
