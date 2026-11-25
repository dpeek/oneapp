import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";
import { controls } from "./tokens.stylex.ts";

const pulse = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.5 },
});
const styles = stylex.create({
  root: {
    maxInlineSize: "100%",
    blockSize: "0.875rem",
    backgroundColor: controls.mutedSurface,
    borderRadius: controls.radius,
    animationName: {
      default: pulse,
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    animationDuration: "2s",
    animationIterationCount: "infinite",
  },
  sm: { inlineSize: "4rem" },
  md: { inlineSize: "6rem" },
  lg: { inlineSize: "12rem" },
});

export const skeleton = <Message>(
  size: "sm" | "md" | "lg",
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.DataAttribute("slot", "skeleton"),
      h.AriaHidden(true),
      h.Class(stylex.props(styles.root, styles[size]).className ?? ""),
    ],
    [],
  );
