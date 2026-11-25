import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";
import { controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "1.5rem",
    minInlineSize: 0,
    padding: { default: "1.5rem", "@media (min-width: 48rem)": "3rem" },
    textAlign: "center",
  },
  header: {
    display: "grid",
    justifyItems: "center",
    gap: "0.5rem",
    maxInlineSize: "24rem",
  },
  media: {
    display: "grid",
    placeItems: "center",
    inlineSize: "2.5rem",
    blockSize: "2.5rem",
    marginBlockEnd: "0.5rem",
    borderRadius: controls.radius,
    backgroundColor: controls.mutedSurface,
    color: controls.foreground,
  },
  title: {
    margin: 0,
    fontSize: "1.125rem",
    fontWeight: 500,
    letterSpacing: "-0.025em",
    lineHeight: 1.5,
    textWrap: "balance",
  },
  description: {
    margin: 0,
    color: controls.mutedForeground,
    fontSize: "0.875rem",
    lineHeight: 1.625,
  },
  content: { display: "flex", justifyContent: "center", maxInlineSize: "100%" },
});

export const empty = <Message>(
  props: { title: string; icon: Html; description?: string; action?: Html },
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.DataAttribute("slot", "empty"),
      h.Class(stylex.props(styles.root).className ?? ""),
    ],
    [
      h.div(
        [
          h.DataAttribute("slot", "empty-header"),
          h.Class(stylex.props(styles.header).className ?? ""),
        ],
        [
          h.div(
            [
              h.DataAttribute("slot", "empty-icon"),
              h.AriaHidden(true),
              h.Class(stylex.props(styles.media).className ?? ""),
            ],
            [props.icon],
          ),
          h.h2(
            [
              h.DataAttribute("slot", "empty-title"),
              h.Class(stylex.props(styles.title).className ?? ""),
            ],
            [props.title],
          ),
          ...(props.description
            ? [
                h.p(
                  [
                    h.DataAttribute("slot", "empty-description"),
                    h.Class(stylex.props(styles.description).className ?? ""),
                  ],
                  [props.description],
                ),
              ]
            : []),
        ],
      ),
      ...(props.action
        ? [
            h.div(
              [
                h.DataAttribute("slot", "empty-content"),
                h.Class(stylex.props(styles.content).className ?? ""),
              ],
              [props.action],
            ),
          ]
        : []),
    ],
  );
