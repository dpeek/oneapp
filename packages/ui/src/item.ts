import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";
import { controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  group: {
    display: "grid",
    gap: "0.5rem",
    listStyle: "none",
    marginBlock: "1rem 0",
    padding: 0,
  },
  item: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    paddingBlock: "0.5rem",
    paddingInline: "0.75rem 0.5rem",
    borderRadius: controls.radius,
    backgroundColor: {
      default: null,
      "@media (hover: hover)": {
        ':has(> [data-slot="item-link"]:hover)': controls.hover,
      },
    },
  },
  link: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    flex: 1,
    minInlineSize: 0,
    textDecoration: "none",
    // Extend the native link across the row while the action sits above it.
    content: { default: null, "::after": '""' },
    position: { default: null, "::after": "absolute" },
    inset: { default: null, "::after": 0 },
    borderRadius: { default: null, "::after": controls.radius },
    outline: {
      default: null,
      ":focus-visible": "none",
      ":focus-visible::after": `2px solid ${controls.focus}`,
    },
    outlineOffset: { default: null, ":focus-visible::after": 3 },
  },
  media: { flexShrink: 0 },
  content: {
    display: "grid",
    flex: 1,
    minInlineSize: 0,
    gap: "0.25rem",
  },
  title: {
    fontSize: "0.9375rem",
    fontWeight: 500,
    overflowWrap: "anywhere",
  },
  description: {
    color: controls.mutedForeground,
    fontSize: "0.8125rem",
  },
  actions: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
  },
});

export const itemGroup = <Message>(
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.ul(
    [
      h.Role("list"),
      h.DataAttribute("slot", "item-group"),
      h.Class(stylex.props(styles.group).className ?? ""),
    ],
    [...children],
  );

type ItemProps = Readonly<{
  key: string;
  href: string;
  target?: "_blank";
  media?: Html;
  title: string;
  description: Html;
  action: Html;
}>;

export const item = <Message>(
  props: ItemProps,
  h: HtmlBuilder<Message>,
): Html => {
  const descriptionId = `item-description-${props.key}`;
  return h.li(
    [
      h.Key(props.key),
      h.DataAttribute("slot", "item"),
      h.DataAttribute("variant", "default"),
      h.Class(stylex.props(styles.item).className ?? ""),
    ],
    [
      h.a(
        [
          h.DataAttribute("slot", "item-link"),
          h.Class(stylex.props(styles.link).className ?? ""),
          h.Href(props.href),
          h.AriaLabel(props.title),
          h.AriaDescribedBy(descriptionId),
          ...(props.target
            ? [h.Target(props.target), h.Rel("noopener noreferrer")]
            : []),
        ],
        [
          ...(props.media
            ? [
                h.div(
                  [
                    h.DataAttribute("slot", "item-media"),
                    h.Class(stylex.props(styles.media).className ?? ""),
                  ],
                  [props.media],
                ),
              ]
            : []),
          h.div(
            [
              h.DataAttribute("slot", "item-content"),
              h.Class(stylex.props(styles.content).className ?? ""),
            ],
            [
              h.div(
                [
                  h.DataAttribute("slot", "item-title"),
                  h.Class(stylex.props(styles.title).className ?? ""),
                ],
                [props.title],
              ),
              h.div(
                [
                  h.Id(descriptionId),
                  h.DataAttribute("slot", "item-description"),
                  h.Class(stylex.props(styles.description).className ?? ""),
                ],
                [props.description],
              ),
            ],
          ),
        ],
      ),
      h.div(
        [
          h.DataAttribute("slot", "item-actions"),
          h.Class(stylex.props(styles.actions).className ?? ""),
        ],
        [props.action],
      ),
    ],
  );
};
