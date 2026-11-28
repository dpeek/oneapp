import * as stylex from "@stylexjs/stylex";
import type {
  Attribute,
  ChildAttribute,
  Html,
  HtmlBuilder,
  TextareaAttribute,
} from "foldkit/html";
import { controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  field: { display: "grid", gap: "0.5rem" },
  label: { fontSize: "0.875rem", fontWeight: 500, lineHeight: 1.25 },
  group: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: "1rem",
    minInlineSize: 0,
  },
  heading: { margin: 0, fontSize: "1rem", fontWeight: 600, lineHeight: 1.5 },
  control: {
    boxSizing: "border-box",
    inlineSize: "100%",
    minInlineSize: 0,
    minBlockSize: "2.25rem",
    paddingBlock: "0.375rem",
    paddingInline: "0.625rem",
    borderColor: {
      default: controls.border,
      ":focus-visible": controls.focus,
      '[aria-invalid="true"]': controls.destructive,
    },
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
      ':focus-visible[aria-invalid="true"]': `0 0 0 1px color-mix(in srgb, ${controls.destructive} 35%, transparent)`,
    },
    "::placeholder": { color: controls.mutedForeground },
  },
  textarea: { minBlockSize: "4rem", resize: "vertical" },
  grouped: {
    borderStyle: "none",
    borderRadius: 0,
    boxShadow: { ":focus-visible": "none" },
  },
});

export const fieldClassNames = {
  root: stylex.props(styles.field).className ?? "",
  label: stylex.props(styles.label).className ?? "",
};

let nextFieldId = 0;

export const createField = ({
  label,
  content,
  control,
  showLabel = true,
}: {
  label: string;
  content: HTMLElement;
  control?: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  showLabel?: boolean;
}) => {
  const element = document.createElement("div");
  element.dataset.slot = "field";
  element.className = fieldClassNames.root;
  if (showLabel) {
    const caption = control
      ? document.createElement("label")
      : document.createElement("span");
    caption.dataset.slot = "field-label";
    caption.className = fieldClassNames.label;
    caption.textContent = label;
    if (caption instanceof HTMLLabelElement && control) {
      control.id ||= `field-${++nextFieldId}`;
      caption.htmlFor = control.id;
    } else {
      caption.id = `field-label-${++nextFieldId}`;
      element.setAttribute("role", "group");
      element.setAttribute("aria-labelledby", caption.id);
    }
    element.append(caption);
  } else control?.setAttribute("aria-label", label);
  element.append(content);
  return element;
};

export const createFieldGroup = (label: string, ...fields: HTMLElement[]) => {
  const element = document.createElement("section");
  element.dataset.slot = "field-group";
  element.className = stylex.props(styles.group).className ?? "";
  const heading = document.createElement("h3");
  heading.id = `field-group-${++nextFieldId}`;
  heading.className = stylex.props(styles.heading).className ?? "";
  heading.textContent = label;
  element.setAttribute("aria-labelledby", heading.id);
  element.append(heading, ...fields);
  return element;
};

export const inputGroupControlClassName = (multiline: boolean) =>
  stylex.props(styles.control, multiline && styles.textarea, styles.grouped)
    .className ?? "";

export const field = <Message>(
  label: string,
  control: Html,
  h: HtmlBuilder<Message>,
): Html =>
  h.label(
    [h.DataAttribute("slot", "field"), h.Class(fieldClassNames.root)],
    [
      h.span(
        [
          h.DataAttribute("slot", "field-label"),
          h.Class(fieldClassNames.label),
        ],
        [label],
      ),
      control,
    ],
  );

export const inputClassName = stylex.props(styles.control).className ?? "";

export const input = <Message>(
  attributes: ReadonlyArray<Attribute<Message> | ChildAttribute>,
  h: HtmlBuilder<Message>,
): Html =>
  h.input([
    ...attributes,
    h.DataAttribute("slot", "input"),
    h.Class(inputClassName),
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
