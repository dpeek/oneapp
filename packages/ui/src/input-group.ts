import * as stylex from "@stylexjs/stylex";
import { controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  root: {
    display: "flex",
    alignItems: "flex-start",
    minInlineSize: 0,
    boxSizing: "border-box",
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: {
      default: controls.radius,
      ':has(> [data-slot="input-group-control"] input)': controls.pillRadius,
    },
    borderColor: {
      default: controls.border,
      ':has([data-slot="input-group-control"] :focus-visible)': controls.focus,
    },
    boxShadow: {
      ':has([data-slot="input-group-control"] :focus-visible)': `0 0 0 1px color-mix(in srgb, ${controls.focus} 35%, transparent)`,
    },
  },
  control: { flex: 1, minInlineSize: 0 },
  addon: {
    display: { default: "flex", ":is([hidden])": "none" },
    flexShrink: 0,
    alignItems: "center",
    gap: "0.125rem",
    paddingBlock: "0.125rem",
    paddingInlineEnd: "0.25rem",
  },
});

export const createInputGroup = (control: HTMLElement, addon: HTMLElement) => {
  const element = document.createElement("div");
  element.dataset.slot = "input-group";
  element.className = stylex.props(styles.root).className ?? "";
  control.dataset.slot = "input-group-control";
  control.className += ` ${stylex.props(styles.control).className ?? ""}`;
  addon.dataset.slot = "input-group-addon";
  addon.dataset.align = "inline-end";
  addon.className += ` ${stylex.props(styles.addon).className ?? ""}`;
  element.append(control, addon);
  return element;
};
