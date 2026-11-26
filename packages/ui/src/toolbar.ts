import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";

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
  controls: { flexShrink: 0, flexWrap: "wrap" },
  end: { flexShrink: 0, marginInlineStart: "auto", justifyContent: "flex-end" },
});

// Crease UI Toolbar layout. Omit the label for layout-only use.
export const toolbar = <Message>(
  props: {
    label?: string;
    start: readonly Html[];
    controls?: readonly Html[];
    end: readonly Html[];
    controlsAfterEnd?: boolean;
  },
  h: HtmlBuilder<Message>,
) => {
  const controls = props.controls
    ? [
        h.div(
          [
            h.Key("toolbar-controls"),
            h.DataAttribute("slot", "toolbar-controls"),
            h.Class(stylex.props(styles.slot, styles.controls).className ?? ""),
          ],
          [...props.controls],
        ),
      ]
    : [];
  const end = h.div(
    [
      h.Key("toolbar-end"),
      h.DataAttribute("slot", "toolbar-end"),
      h.Class(stylex.props(styles.slot, styles.end).className ?? ""),
    ],
    [...props.end],
  );
  return h.div(
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
      ...(props.controlsAfterEnd ? [end, ...controls] : [...controls, end]),
    ],
  );
};
