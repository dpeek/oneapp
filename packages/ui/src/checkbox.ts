import { Checkbox } from "@foldkit/ui";
import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";
import { outlineIcon } from "./icons.ts";
import { controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  row: { display: "flex", alignItems: "start", gap: "0.5rem" },
  control: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    inlineSize: "1rem",
    blockSize: "1rem",
    padding: 0,
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: { default: controls.border, ":focus-visible": controls.focus },
    borderRadius: "0.25rem",
    backgroundColor: "transparent",
    boxShadow: {
      default: "0 1px 2px rgb(0 0 0 / 5%)",
      ":focus-visible": `0 0 0 1px color-mix(in srgb, ${controls.focus} 35%, transparent)`,
    },
    outlineStyle: "none",
    cursor: "pointer",
  },
  checked: {
    borderColor: controls.primary,
    backgroundColor: controls.primary,
    color: controls.onPrimary,
  },
  indicator: { display: "grid", placeItems: "center" },
  label: {
    fontSize: "0.875rem",
    fontWeight: 500,
    lineHeight: "1rem",
    userSelect: "none",
    cursor: "pointer",
  },
  disabled: { opacity: 0.5, cursor: "default" },
});

export const checkbox = <Message>(
  {
    id,
    label,
    checked,
    disabled = false,
    onToggle,
  }: {
    id: string;
    label: string;
    checked: boolean;
    disabled?: boolean;
    onToggle: (checked: boolean) => Message;
  },
  h: HtmlBuilder<Message>,
): Html =>
  Checkbox.view(
    {
      id,
      isChecked: checked,
      isDisabled: disabled,
      onToggle,
      toView: ({ checkbox: control }) =>
        h.div(
          [
            h.DataAttribute("slot", "checkbox-field"),
            h.Class(stylex.props(styles.row).className ?? ""),
          ],
          [
            h.button(
              [
                ...control,
                h.Id(id),
                h.Disabled(disabled),
                h.DataAttribute("slot", "checkbox"),
                h.Class(
                  stylex.props(
                    styles.control,
                    checked && styles.checked,
                    disabled && styles.disabled,
                  ).className ?? "",
                ),
              ],
              checked
                ? [
                    h.span(
                      [
                        h.DataAttribute("slot", "checkbox-indicator"),
                        h.Class(stylex.props(styles.indicator).className ?? ""),
                      ],
                      [outlineIcon(h, ["m5 12 4 4L19 6"])],
                    ),
                  ]
                : [],
            ),
            h.label(
              [
                h.Id(Checkbox.labelId(id)),
                h.For(id),
                h.DataAttribute("slot", "checkbox-label"),
                h.Class(
                  stylex.props(styles.label, disabled && styles.disabled)
                    .className ?? "",
                ),
              ],
              [label],
            ),
          ],
        ),
    },
    h,
  );
