import type { Html, HtmlBuilder } from "foldkit/html";
import { button } from "./button.ts";

// The two-slot Crease UI Toolbar layout. The controls keep their native tab order.
export const toolbar = <Message>(
  props: {
    label: string;
    start: readonly Html[];
    end: readonly Html[];
  },
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [
      h.Role("toolbar"),
      h.AriaLabel(props.label),
      h.DataAttribute("slot", "toolbar"),
    ],
    [
      h.div([h.DataAttribute("slot", "toolbar-start")], [...props.start]),
      h.div([h.DataAttribute("slot", "toolbar-end")], [...props.end]),
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
