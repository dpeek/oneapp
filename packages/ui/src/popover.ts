import { Popover } from "@foldkit/ui";
import * as stylex from "@stylexjs/stylex";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { buttonClassName } from "./button.ts";
import { controls } from "./tokens.stylex.ts";

export { anchorSetup } from "@foldkit/ui/anchor";
export const { Model, Message, init, update, buttonId } = Popover;

const styles = stylex.create({
  root: { display: "inline-flex" },
  button: { backgroundColor: { ":is([data-open])": controls.hover } },
  backdrop: { position: "fixed", inset: 0, zIndex: 49 },
  panel: {
    zIndex: 50,
    maxInlineSize: "calc(100vw - 1rem)",
    maxBlockSize: "min(30rem, calc(100dvh - 2rem))",
    overflowY: "auto",
    padding: "0.75rem",
    border: `1px solid ${controls.border}`,
    borderRadius: controls.radius,
    backgroundColor: controls.popover,
    color: controls.foreground,
    boxShadow: "0 4px 12px rgb(0 0 0 / 15%)",
  },
});

export const view = <ParentMessage>(
  props: {
    model: typeof Model.Type;
    label: string;
    triggerLabel?: string;
    disabled?: boolean;
    trigger: Html;
    triggerButton?: Parameters<typeof buttonClassName>[0];
    triggerClassName?: string;
    triggerAttributes?: readonly Attribute<ParentMessage>[];
    content: Html;
    placement?: "bottom-start" | "bottom-end" | "top-end";
    portal?: boolean;
    panelClassName?: string;
    focusSelector?: string;
    toParentMessage: (message: typeof Message.Type) => ParentMessage;
  },
  h: HtmlBuilder<ParentMessage>,
): Html =>
  h.submodel({
    slotId: props.model.id,
    model: props.model,
    view: Popover.view,
    viewInputs: {
      anchor: {
        placement: props.placement ?? "bottom-end",
        gap: 4,
        portal: props.portal,
      },
      ariaLabel: props.triggerLabel ?? props.label,
      focusSelector: props.focusSelector,
      toView: ({ button, panel, backdrop, isVisible }) =>
        h.div(
          [h.Class(stylex.props(styles.root).className ?? "")],
          [
            h.button(
              [
                ...button,
                h.DataAttribute("slot", "button"),
                h.AriaHasPopup("dialog"),
                // The portaled backdrop paints before the trigger at this layer.
                ...(isVisible
                  ? [h.Style({ position: "relative", zIndex: "49" })]
                  : []),
                h.Title(props.label),
                ...(props.triggerAttributes ?? []),
                h.Disabled(props.disabled ?? false),
                h.Class(
                  [
                    buttonClassName(
                      props.triggerButton ?? {
                        variant: "ghost",
                        size: "icon-sm",
                      },
                    ),
                    stylex.props(styles.button).className,
                    props.triggerClassName,
                  ]
                    .filter(Boolean)
                    .join(" "),
                ),
              ],
              [props.trigger],
            ),
            ...(isVisible
              ? [
                  h.div(
                    [
                      ...backdrop,
                      h.Class(stylex.props(styles.backdrop).className ?? ""),
                    ],
                    [],
                  ),
                  h.div(
                    [
                      ...panel,
                      h.Role("dialog"),
                      h.AriaLabel(props.label),
                      h.Class(
                        [
                          stylex.props(styles.panel).className,
                          props.panelClassName,
                        ]
                          .filter(Boolean)
                          .join(" "),
                      ),
                    ],
                    [props.content],
                  ),
                ]
              : []),
          ],
        ),
    },
    toParentMessage: props.toParentMessage,
  });
