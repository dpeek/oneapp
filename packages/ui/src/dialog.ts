import { Dialog } from "@foldkit/ui";
import * as stylex from "@stylexjs/stylex";
import type {
  Attribute,
  ChildAttribute,
  Html,
  HtmlBuilder,
} from "foldkit/html";
import { buttonClassName } from "./button.ts";
import { outlineIcon } from "./icons.ts";
import { controls } from "./tokens.stylex.ts";

export const { Model, Message, init, open, close, update } = Dialog;

const styles = stylex.create({
  root: {
    display: { default: "none", ":is([open])": "flex" },
    alignItems: "center",
    justifyContent: "center",
    margin: 0,
    overflow: "hidden",
    color: controls.foreground,
  },
  overlay: {
    position: "absolute",
    inset: 0,
    backgroundColor: "rgb(10 11 18 / 65%)",
  },
  panel: {
    position: "relative",
    display: "grid",
    gap: "1rem",
  },
  surface: {
    boxSizing: "border-box",
    inlineSize: "min(32rem, calc(100% - 2rem))",
    maxBlockSize: "calc(100dvh - 2rem)",
    overflow: "auto",
    overscrollBehavior: "contain",
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: controls.border,
    borderRadius: "0.75rem",
    backgroundColor: controls.surface,
    color: controls.foreground,
    boxShadow: "0 10px 24px rgb(0 0 0 / 20%)",
  },
  wide: { inlineSize: "min(36rem, calc(100% - 2rem))" },
  padding: { padding: "clamp(1rem, 4vw, 1.5rem)" },
  native: {
    "::backdrop": { backgroundColor: "rgb(10 11 18 / 65%)" },
  },
  content: { display: "grid", gap: "1rem" },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
  },
  title: { margin: 0, fontSize: "1.125rem", fontWeight: 600, lineHeight: 1.25 },
  footer: {
    display: "flex",
    flexDirection: {
      default: "column-reverse",
      "@media (min-width: 40rem)": "row",
    },
    justifyContent: "flex-end",
    gap: "0.5rem",
  },
});

export const footer = <ParentMessage>(
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<ParentMessage>,
): Html =>
  h.div(
    [
      h.DataAttribute("slot", "dialog-footer"),
      h.Class(stylex.props(styles.footer).className ?? ""),
    ],
    [...children],
  );

// Crease's centered dialog layout on the installed Foldkit Dialog primitive.
export const view = <ParentMessage>(
  props: Readonly<{
    model: typeof Model.Type;
    title: string;
    content: (initialFocus: ReadonlyArray<ChildAttribute>) => Html;
    size?: "wide";
    padded?: boolean;
    showHeader?: boolean;
    showCloseButton?: boolean;
    toParentMessage: (message: typeof Message.Type) => ParentMessage;
  }>,
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
                    h.DataAttribute("slot", "dialog-overlay"),
                    h.Class(stylex.props(styles.overlay).className ?? ""),
                  ],
                  [],
                ),
                h.div(
                  [
                    ...panel,
                    h.DataAttribute("slot", "dialog-content"),
                    h.Class(
                      stylex.props(
                        styles.panel,
                        styles.surface,
                        props.size === "wide" && styles.wide,
                        props.padded !== false && styles.padding,
                      ).className ?? "",
                    ),
                  ],
                  [
                    props.showHeader === false
                      ? h.span([...title, h.Hidden(true)], [props.title])
                      : h.header(
                          [
                            h.DataAttribute("slot", "dialog-header"),
                            h.Class(
                              stylex.props(styles.header).className ?? "",
                            ),
                          ],
                          [
                            h.h2(
                              [
                                ...title,
                                h.DataAttribute("slot", "dialog-title"),
                                h.Class(
                                  stylex.props(styles.title).className ?? "",
                                ),
                              ],
                              [props.title],
                            ),
                            ...((props.showCloseButton ?? true)
                              ? [
                                  h.button(
                                    [
                                      ...closeButton,
                                      h.AriaLabel("Close"),
                                      h.DataAttribute("slot", "dialog-close"),
                                      h.Class(
                                        buttonClassName({
                                          variant: "ghost",
                                          size: "icon",
                                          rounded: true,
                                        }),
                                      ),
                                    ],
                                    [outlineIcon(h, ["M6 6l12 12M6 18L18 6"])],
                                  ),
                                ]
                              : []),
                          ],
                        ),
                    props.content(initialFocus),
                  ],
                ),
              ]
            : [],
        ),
    },
    toParentMessage: props.toParentMessage,
  });

export const dialog = <Message>(
  props: Readonly<{
    titleId: string;
    title: string;
    children: ReadonlyArray<Html>;
    attributes: ReadonlyArray<Attribute<Message>>;
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.dialog(
    [
      ...props.attributes,
      h.AriaLabelledBy(props.titleId),
      h.DataAttribute("slot", "dialog"),
      h.Class(
        stylex.props(styles.surface, styles.padding, styles.native).className ??
          "",
      ),
    ],
    [
      h.div(
        [
          h.DataAttribute("slot", "dialog-content"),
          h.Class(stylex.props(styles.content).className ?? ""),
        ],
        [
          h.h2(
            [
              h.Id(props.titleId),
              h.DataAttribute("slot", "dialog-title"),
              h.Class(stylex.props(styles.title).className ?? ""),
            ],
            [props.title],
          ),
          ...props.children,
        ],
      ),
    ],
  );
