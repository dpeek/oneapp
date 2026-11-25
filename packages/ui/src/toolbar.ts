import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";
import { button } from "./button.ts";

const styles = stylex.create({
  layout: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.25rem",
    minBlockSize: "1.75rem",
  },
  slot: {
    display: "flex",
    alignItems: "center",
    minInlineSize: 0,
    gap: "0.25rem",
  },
  end: { flexShrink: 0, justifyContent: "flex-end" },
});

// The two-slot Crease UI Toolbar layout. Omit the label for layout-only use.
export const toolbar = <Message>(
  props: {
    label?: string;
    start: readonly Html[];
    end: readonly Html[];
  },
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [
      ...(props.label === undefined
        ? []
        : [h.Role("toolbar"), h.AriaLabel(props.label)]),
      h.DataAttribute("slot", "toolbar"),
      h.Class(stylex.props(styles.layout).className ?? ""),
    ],
    [
      h.div(
        [
          h.DataAttribute("slot", "toolbar-start"),
          h.Class(stylex.props(styles.slot).className ?? ""),
        ],
        [...props.start],
      ),
      h.div(
        [
          h.DataAttribute("slot", "toolbar-end"),
          h.Class(stylex.props(styles.slot, styles.end).className ?? ""),
        ],
        [...props.end],
      ),
    ],
  );

export const toggleGroup = <Value extends string, Message>(
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
    ],
    props.items.map((item) =>
      button(
        {
          variant: "ghost",
          size: "sm",
          disabled: props.disabled,
          attributes: [h.AriaPressed(String(item.value === props.value))],
          onClick: props.onToggle(item.value),
          children: [item.label],
        },
        h,
      ),
    ),
  );
