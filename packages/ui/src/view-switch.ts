import * as stylex from "@stylexjs/stylex";
import type { HtmlBuilder } from "foldkit/html";
import { button } from "./button.ts";

const styles = stylex.create({
  group: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    maxInlineSize: "100%",
  },
});

export const viewSwitchGroupClassName =
  stylex.props(styles.group).className ?? "";
export const viewSwitchButton = {
  variant: "quiet",
  size: "sm",
  rounded: true,
} as const;

export const viewToggleGroup = <Value extends string, Message>(
  props: {
    label: string;
    value: Value;
    items: readonly { value: Value; label: string }[];
    disabled?: boolean;
    onToggle: (value: Value) => Message;
  },
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [
      h.Role("group"),
      h.AriaLabel(props.label),
      h.DataAttribute("slot", "toggle-group"),
      h.Class(viewSwitchGroupClassName),
    ],
    props.items.map((item) =>
      button(
        {
          ...viewSwitchButton,
          disabled: props.disabled,
          attributes: [h.AriaPressed(String(item.value === props.value))],
          onClick: props.onToggle(item.value),
          children: [item.label],
        },
        h,
      ),
    ),
  );
