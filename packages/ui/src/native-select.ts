import * as stylex from "@stylexjs/stylex";
import type {
  Attribute,
  ChildAttribute,
  Html,
  HtmlBuilder,
} from "foldkit/html";
import { createField, field } from "./field.ts";
import { controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  wrapper: {
    position: "relative",
    inlineSize: "fit-content",
    maxInlineSize: "100%",
    opacity: { ":has(select:disabled)": 0.5 },
  },
  control: {
    appearance: "none",
    boxSizing: "border-box",
    inlineSize: "100%",
    minInlineSize: 0,
    minBlockSize: "2rem",
    paddingBlock: "0.375rem",
    paddingInlineStart: "0.625rem",
    paddingInlineEnd: "2rem",
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: controls.pillRadius,
    borderColor: {
      default: controls.border,
      ":focus-visible": controls.focus,
      '[aria-invalid="true"]': controls.destructive,
    },
    backgroundColor: "transparent",
    color: controls.foreground,
    fontFamily: "inherit",
    fontSize: { default: "1rem", "@media (min-width: 768px)": "0.875rem" },
    lineHeight: 1.25,
    outlineStyle: "none",
    textOverflow: "ellipsis",
    boxShadow: {
      default: "0 1px 2px rgb(0 0 0 / 5%)",
      ":focus-visible": `0 0 0 1px color-mix(in srgb, ${controls.focus} 35%, transparent)`,
      ':focus-visible[aria-invalid="true"]': `0 0 0 1px color-mix(in srgb, ${controls.destructive} 35%, transparent)`,
    },
  },
  ghost: {
    display: "block",
    minBlockSize: { default: "2rem", "@media (pointer: coarse)": "2.75rem" },
    paddingBlock: "0.25rem",
    borderColor: "transparent",
    backgroundColor: {
      default: "transparent",
      "@media (hover: hover)": { ":hover:not(:disabled)": controls.hover },
    },
    color: controls.mutedForeground,
    fontSize: "0.875rem",
    fontWeight: 600,
    lineHeight: "1.25rem",
    cursor: { default: "pointer", ":disabled": "default" },
    boxShadow: "none",
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: 2,
    outlineColor: controls.focus,
    outlineOffset: { ":focus-visible": 3 },
  },
  icon: {
    position: "absolute",
    insetBlockStart: "50%",
    insetInlineEnd: "0.75rem",
    inlineSize: "1rem",
    blockSize: "1rem",
    transform: "translateY(-50%)",
    color: controls.mutedForeground,
    opacity: 0.5,
    pointerEvents: "none",
  },
  option: { backgroundColor: "Canvas", color: "CanvasText" },
});

type NativeSelectProps = {
  label: string;
  options: readonly { value: string; label: string }[];
  value: string;
};

const wrapperClassName = stylex.props(styles.wrapper).className ?? "";
const controlClassName = stylex.props(styles.control).className ?? "";
const iconClassName = stylex.props(styles.icon).className ?? "";
const optionClassName = stylex.props(styles.option).className ?? "";
const chevronPath = "m6 9 6 6 6-6";

export const nativeSelect = <Message>(
  {
    label,
    options,
    value,
    disabled = false,
    variant = "outline",
    showLabel = true,
    attributes = [],
    onChange,
  }: NativeSelectProps & {
    disabled?: boolean;
    variant?: "outline" | "ghost";
    showLabel?: boolean;
    attributes?: ReadonlyArray<Attribute<Message> | ChildAttribute>;
    onChange: (value: string) => Message;
  },
  h: HtmlBuilder<Message>,
): Html => {
  const control = h.span(
    [
      h.DataAttribute("slot", "native-select-wrapper"),
      h.Class(wrapperClassName),
    ],
    [
      h.select(
        [
          h.DataAttribute("slot", "native-select"),
          h.Class(
            variant === "ghost"
              ? (stylex.props(styles.control, styles.ghost).className ?? "")
              : controlClassName,
          ),
          ...(showLabel ? [] : [h.AriaLabel(label)]),
          h.Value(value),
          h.Disabled(disabled),
          h.OnChange(onChange),
          ...attributes,
        ],
        options.map((option) =>
          h.option(
            [
              h.Key(option.value),
              h.DataAttribute("slot", "native-select-option"),
              h.Class(optionClassName),
              h.Value(option.value),
            ],
            [option.label],
          ),
        ),
      ),
      h.svg(
        [
          h.DataAttribute("slot", "native-select-icon"),
          h.Class(iconClassName),
          h.ViewBox("0 0 24 24"),
          h.AriaHidden(true),
        ],
        [
          h.path(
            [
              h.D(chevronPath),
              h.Fill("none"),
              h.Stroke("currentColor"),
              h.StrokeWidth("2"),
              h.StrokeLinecap("round"),
              h.StrokeLinejoin("round"),
            ],
            [],
          ),
        ],
      ),
    ],
  );
  return showLabel ? field(label, control, h) : control;
};

export const createNativeSelect = ({
  label,
  options,
  value,
}: NativeSelectProps) => {
  const wrapper = document.createElement("span");
  wrapper.dataset.slot = "native-select-wrapper";
  wrapper.className = wrapperClassName;

  const select = document.createElement("select");
  select.dataset.slot = "native-select";
  select.className = controlClassName;
  for (const option of options) {
    const selected = option.value === value;
    const entry = new Option(option.label, option.value, selected, selected);
    entry.dataset.slot = "native-select-option";
    entry.className = optionClassName;
    select.add(entry);
  }

  const svgNamespace = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(svgNamespace, "svg");
  icon.dataset.slot = "native-select-icon";
  icon.setAttribute("class", iconClassName);
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const chevron = document.createElementNS(svgNamespace, "path");
  chevron.setAttribute("d", chevronPath);
  chevron.setAttribute("fill", "none");
  chevron.setAttribute("stroke", "currentColor");
  chevron.setAttribute("stroke-width", "2");
  chevron.setAttribute("stroke-linecap", "round");
  chevron.setAttribute("stroke-linejoin", "round");
  icon.append(chevron);

  wrapper.append(select, icon);
  const element = createField({ label, content: wrapper, control: select });
  return { element, select };
};
