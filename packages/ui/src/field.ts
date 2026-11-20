import * as stylex from "@stylexjs/stylex";
import type {
  Attribute,
  Html,
  HtmlBuilder,
  TextareaAttribute,
} from "foldkit/html";
import { controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  field: { display: "grid", gap: "0.5rem" },
  label: { fontSize: "0.875rem", fontWeight: 500, lineHeight: 1.25 },
  control: {
    boxSizing: "border-box",
    inlineSize: "100%",
    minInlineSize: 0,
    minBlockSize: "2.25rem",
    paddingBlock: "0.375rem",
    paddingInline: "0.625rem",
    borderColor: { default: controls.border, ":focus-visible": controls.focus },
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: controls.radius,
    backgroundColor: "transparent",
    color: controls.foreground,
    fontFamily: "inherit",
    fontSize: { default: "1rem", "@media (min-width: 768px)": "0.875rem" },
    lineHeight: 1.5,
    outlineStyle: "none",
    boxShadow: {
      ":focus-visible": `0 0 0 1px color-mix(in srgb, ${controls.focus} 35%, transparent)`,
    },
    "::placeholder": { color: controls.mutedForeground },
  },
  textarea: { minBlockSize: "4rem", resize: "vertical" },
});

export const field = <Message>(
  label: string,
  control: Html,
  h: HtmlBuilder<Message>,
): Html =>
  h.label(
    [
      h.DataAttribute("slot", "field"),
      h.Class(stylex.props(styles.field).className ?? ""),
    ],
    [
      h.span(
        [
          h.DataAttribute("slot", "field-label"),
          h.Class(stylex.props(styles.label).className ?? ""),
        ],
        [label],
      ),
      control,
    ],
  );

export const input = <Message>(
  attributes: ReadonlyArray<Attribute<Message>>,
  h: HtmlBuilder<Message>,
): Html =>
  h.input([
    ...attributes,
    h.DataAttribute("slot", "input"),
    h.Class(stylex.props(styles.control).className ?? ""),
  ]);

export const textarea = <Message>(
  attributes: ReadonlyArray<TextareaAttribute<Message>>,
  h: HtmlBuilder<Message>,
): Html =>
  h.textarea([
    ...attributes,
    h.DataAttribute("slot", "textarea"),
    h.Class(stylex.props(styles.control, styles.textarea).className ?? ""),
  ]);
