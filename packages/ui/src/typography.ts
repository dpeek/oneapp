import * as stylex from "@stylexjs/stylex";
import { controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  body: { fontSize: "1rem", lineHeight: 1.65 },
  heading: { fontWeight: 650, letterSpacing: "-0.025em", lineHeight: 1.3 },
  h1: { fontSize: "1.625rem" },
  h2: { fontSize: "1.375rem" },
  h3: { fontSize: "1.1875rem" },
  h4: { fontSize: "1.0625rem" },
  h5: { fontSize: "1rem" },
  h6: { fontSize: "0.9375rem" },
  quote: {
    fontStyle: "italic",
    borderInlineStartColor: controls.border,
    borderInlineStartStyle: "solid",
    borderInlineStartWidth: 2,
    paddingInlineStart: "1rem",
  },
  code: {
    backgroundColor: controls.hover,
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
  },
  inlineCode: {
    fontSize: "0.875em",
    paddingInline: "0.3em",
    borderRadius: "0.25em",
  },
  codeBlock: {
    fontSize: "0.875rem",
    lineHeight: 1.6,
    padding: "0.75rem 1rem",
    borderRadius: controls.radius,
  },
});

const headingClassName = (tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
  stylex.props(styles.heading, styles[tag]).className ?? "";

// Crease typography styles for document elements rendered by the editor.
export const documentTypography = {
  body: stylex.props(styles.body).className ?? "",
  heading: {
    h1: headingClassName("h1"),
    h2: headingClassName("h2"),
    h3: headingClassName("h3"),
    h4: headingClassName("h4"),
    h5: headingClassName("h5"),
    h6: headingClassName("h6"),
  },
  quote: stylex.props(styles.quote).className ?? "",
  inlineCode: stylex.props(styles.code, styles.inlineCode).className ?? "",
  codeBlock: stylex.props(styles.code, styles.codeBlock).className ?? "",
};
