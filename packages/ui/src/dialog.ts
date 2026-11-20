import * as stylex from "@stylexjs/stylex";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  root: {
    boxSizing: "border-box",
    inlineSize: "min(32rem, calc(100% - 2rem))",
    maxBlockSize: "calc(100dvh - 2rem)",
    overflow: "auto",
    overscrollBehavior: "contain",
    padding: "clamp(1rem, 4vw, 1.5rem)",
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: controls.border,
    borderRadius: "0.75rem",
    backgroundColor: controls.surface,
    color: controls.foreground,
    boxShadow: "0 10px 24px rgb(0 0 0 / 20%)",
    "::backdrop": { backgroundColor: "rgb(10 11 18 / 65%)" },
  },
  content: { display: "grid", gap: "1rem" },
  title: { margin: 0, fontSize: "1.125rem", fontWeight: 600, lineHeight: 1.25 },
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
      h.Class(stylex.props(styles.root).className ?? ""),
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
