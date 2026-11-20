import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";

const styles = stylex.create({
  group: {
    display: "flex",
    alignItems: "stretch",
  },
});

export const buttonGroup = <Message>(
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Role("group"),
      h.DataAttribute("slot", "button-group"),
      h.Class(stylex.props(styles.group).className ?? ""),
    ],
    [...children],
  );
