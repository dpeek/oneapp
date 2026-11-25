import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";

const styles = stylex.create({
  hidden: {
    position: "absolute",
    inlineSize: 1,
    blockSize: 1,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
});

export const visuallyHiddenStatus = <Message>(
  message: string | null,
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [h.Role("status"), h.Class(stylex.props(styles.hidden).className ?? "")],
    message ? [message] : [],
  );
