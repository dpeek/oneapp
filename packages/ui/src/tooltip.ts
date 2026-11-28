import { Tooltip } from "@foldkit/ui";
import type { Placement } from "@foldkit/ui/anchor";
import * as stylex from "@stylexjs/stylex";
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html";
import { controls } from "./tokens.stylex.ts";

export const { Model, Message, init, update } = Tooltip;

const styles = stylex.create({
  root: { display: "inline-flex", position: "relative" },
  panel: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    borderRadius: controls.radius,
    paddingBlock: "0.375rem",
    paddingInline: "0.625rem",
    backgroundColor: controls.foreground,
    color: controls.surface,
    fontSize: "0.8125rem",
    inlineSize: "max-content",
    maxInlineSize: "min(20rem, calc(100vw - 4rem))",
    overflowWrap: "anywhere",
    textAlign: "start",
    pointerEvents: "none",
    zIndex: 2,
  },
});

export const tooltip = <ParentMessage>(
  props: {
    model: typeof Model.Type;
    content: string | ReadonlyArray<Html | string>;
    placement?: Placement;
    renderTrigger: (attributes: ReadonlyArray<ChildAttribute>) => Html;
    toParentMessage: (message: typeof Message.Type) => ParentMessage;
  },
  h: HtmlBuilder<ParentMessage>,
): Html =>
  h.submodel({
    slotId: props.model.id,
    model: props.model,
    view: Tooltip.view,
    viewInputs: {
      anchor: { placement: props.placement ?? "right", gap: 8, portal: false },
      toView: ({ trigger, panel, isVisible }) =>
        h.span(
          [h.Class(stylex.props(styles.root).className ?? "")],
          [
            props.renderTrigger(trigger),
            ...(isVisible
              ? [
                  h.span(
                    [
                      ...panel,
                      h.DataAttribute("slot", "tooltip-content"),
                      h.Class(stylex.props(styles.panel).className ?? ""),
                    ],
                    typeof props.content === "string"
                      ? [props.content]
                      : [...props.content],
                  ),
                ]
              : []),
          ],
        ),
    },
    toParentMessage: props.toParentMessage,
  });
