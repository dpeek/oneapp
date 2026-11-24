import { Popover } from "@foldkit/ui";
import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";
import { buttonClassName } from "./button.ts";
import { controls } from "./tokens.stylex.ts";

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
    disabled?: boolean;
    trigger: Html;
    content: Html;
    toParentMessage: (message: typeof Message.Type) => ParentMessage;
  },
  h: HtmlBuilder<ParentMessage>,
): Html =>
  h.submodel({
    slotId: props.model.id,
    model: props.model,
    view: Popover.view,
    viewInputs: {
      anchor: { placement: "bottom-end", gap: 4 },
      ariaLabel: props.label,
      toView: ({ button, panel, backdrop, isVisible }) =>
        h.div(
          [h.Class(stylex.props(styles.root).className ?? "")],
          [
            h.button(
              [
                ...button,
                h.DataAttribute("slot", "button"),
                h.Title(props.label),
                h.Disabled(props.disabled ?? false),
                h.Class(
                  [
                    buttonClassName({
                      variant: "ghost",
                      size: "icon-sm",
                      rounded: true,
                    }),
                    stylex.props(styles.button).className,
                  ].join(" "),
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
                      h.Class(stylex.props(styles.panel).className ?? ""),
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
