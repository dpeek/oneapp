import { Dialog } from "@foldkit/ui";
import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";
import { controls } from "./tokens.stylex.ts";

export const { Model, Message, init, update } = Dialog;

const styles = stylex.create({
  root: {
    margin: 0,
    overflow: "hidden",
    color: controls.foreground,
  },
  overlay: {
    position: "absolute",
    inset: 0,
    backgroundColor: "rgb(10 11 18 / 60%)",
  },
  panel: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    gap: "1rem",
    inlineSize: "min(19rem, calc(100% - 3rem))",
    blockSize: "100%",
    overflow: "auto",
    overscrollBehavior: "contain",
    paddingBlockStart: "max(1rem, env(safe-area-inset-top))",
    paddingBlockEnd: "max(1rem, env(safe-area-inset-bottom))",
    paddingInline: "1rem",
    borderInlineEnd: `1px solid ${controls.border}`,
    backgroundColor: controls.surface,
    boxShadow: "0 10px 24px rgb(0 0 0 / 20%)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
  },
  title: { margin: 0, fontSize: "1.125rem" },
});

// Crease's left-edge Sheet layout on the installed Foldkit Dialog primitive.
export const sheet = <ParentMessage>(
  props: {
    model: typeof Model.Type;
    title: string;
    content: Html;
    toParentMessage: (message: typeof Message.Type) => ParentMessage;
  },
  h: HtmlBuilder<ParentMessage>,
): Html =>
  h.submodel({
    slotId: props.model.id,
    model: props.model,
    view: Dialog.view,
    viewInputs: {
      toView: ({
        dialog,
        backdrop,
        panel,
        title,
        closeButton,
        initialFocus,
        isVisible,
      }) =>
        h.dialog(
          [...dialog, h.Class(stylex.props(styles.root).className ?? "")],
          isVisible
            ? [
                h.div(
                  [
                    ...backdrop,
                    h.Class(stylex.props(styles.overlay).className ?? ""),
                  ],
                  [],
                ),
                h.div(
                  [
                    ...panel,
                    h.Class(stylex.props(styles.panel).className ?? ""),
                  ],
                  [
                    h.header(
                      [h.Class(stylex.props(styles.header).className ?? "")],
                      [
                        h.h2(
                          [
                            ...title,
                            h.Class(stylex.props(styles.title).className ?? ""),
                          ],
                          [props.title],
                        ),
                        h.button([...closeButton, ...initialFocus], ["Close"]),
                      ],
                    ),
                    props.content,
                  ],
                ),
              ]
            : [],
        ),
    },
    toParentMessage: props.toParentMessage,
  });
