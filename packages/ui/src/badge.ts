import * as stylex from "@stylexjs/stylex";
import type { HtmlBuilder } from "foldkit/html";
import { controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  badge: {
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    minInlineSize: "1.125rem",
    blockSize: "1.125rem",
    boxSizing: "border-box",
    paddingInline: "0.3rem",
    borderRadius: "9999px",
    backgroundColor: controls.primary,
    color: controls.onPrimary,
    fontSize: "0.6875rem",
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
  },
});

export const badge = <Message>(label: string, h: HtmlBuilder<Message>) =>
  h.span(
    [
      h.DataAttribute("slot", "badge"),
      h.Class(stylex.props(styles.badge).className ?? ""),
    ],
    [label],
  );
