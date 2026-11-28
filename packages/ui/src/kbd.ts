import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";
import { controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  key: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    blockSize: "1.25rem",
    minInlineSize: "1.25rem",
    paddingInline: "0.25rem",
    borderRadius: "0.25rem",
    backgroundColor: controls.mutedSurface,
    color: controls.mutedForeground,
    fontFamily: "inherit",
    fontSize: "0.75rem",
    fontWeight: 500,
    lineHeight: "1rem",
    pointerEvents: "none",
    userSelect: "none",
  },
});

export const kbd = <Message>(key: string, h: HtmlBuilder<Message>): Html =>
  h.kbd(
    [
      h.DataAttribute("slot", "kbd"),
      h.Class(stylex.props(styles.key).className ?? ""),
    ],
    [key],
  );
