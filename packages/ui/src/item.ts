import * as stylex from "@stylexjs/stylex";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
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
    borderRadius: controls.radius,
    backgroundColor: {
      default: null,
      "@media (hover: hover)": {
        ':has([data-slot="item-link"]:hover, > [data-slot="item-header"] > [data-item-disclosure]:hover)':
          controls.hover,
      },
    },
  },
  outline: { boxShadow: `inset 0 0 0 1px ${controls.border}` },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    paddingBlock: "0.5rem",
    paddingInline: "0.75rem 0.5rem",
  },
  panel: { paddingBlockEnd: "0.625rem", paddingInline: "0.75rem" },
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
  body: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    flex: 1,
    minInlineSize: 0,
  },
  media: { flexShrink: 0 },
  linkButton: {
    borderStyle: "none",
    padding: 0,
    backgroundColor: "transparent",
    color: controls.foreground,
    fontFamily: "inherit",
    textAlign: "start",
    cursor: "pointer",
  },
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
  trailing: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    gap: "0.25rem",
  },
  summary: {
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
    flex: 1,
    minInlineSize: 0,
    minBlockSize: "2rem",
    color: controls.mutedForeground,
    fontSize: "0.8125rem",
  },
  disclosure: {
    borderStyle: "none",
    padding: 0,
    backgroundColor: "transparent",
    fontFamily: "inherit",
    textAlign: "start",
    borderRadius: controls.radius,
    cursor: "pointer",
    outline: { ":focus-visible": `2px solid ${controls.focus}` },
    outlineOffset: { ":focus-visible": 2 },
  },
});

export const itemClassName = (variant: ItemVariant = "default") =>
  stylex.props(styles.item, styles.row, variant === "outline" && styles.outline)
    .className ?? "";

export const itemClassNames = {
  group: stylex.props(styles.group).className ?? "",
  button: stylex.props(styles.link, styles.linkButton).className ?? "",
  media: stylex.props(styles.media).className ?? "",
  content: stylex.props(styles.content).className ?? "",
  title: stylex.props(styles.title).className ?? "",
  description: stylex.props(styles.description).className ?? "",
  actions: stylex.props(styles.actions).className ?? "",
};

export const itemGroup = <Message>(
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.ul(
    [
      h.Role("list"),
      h.DataAttribute("slot", "item-group"),
      h.Class(itemClassNames.group),
    ],
    [...children],
  );

type ItemVariant = "default" | "outline";

type ItemProps<Message> = Readonly<{
  key: string;
  href?: string;
  // Keep interactive media and descriptions outside the stretched row link.
  linkTitleOnly?: boolean;
  variant?: ItemVariant;
  target?: "_blank";
  media?: Html;
  title: string;
  description?: Html;
  action?: Html;
  attributes?: ReadonlyArray<Attribute<Message>>;
  linkAttributes?: ReadonlyArray<Attribute<Message>>;
}>;

export const item = <Message>(
  props: ItemProps<Message>,
  h: HtmlBuilder<Message>,
): Html => {
  const descriptionId = `item-description-${props.key}`;
  const { variant = "default" } = props;
  const link = (children: Html[]) =>
    h.a(
      [
        h.DataAttribute("slot", "item-link"),
        h.Class(stylex.props(styles.link).className ?? ""),
        h.Href(props.href!),
        h.AriaLabel(props.title),
        ...(props.description === undefined
          ? []
          : [h.AriaDescribedBy(descriptionId)]),
        ...(props.linkAttributes ?? []),
        ...(props.target
          ? [h.Target(props.target), h.Rel("noopener noreferrer")]
          : []),
      ],
      children,
    );
  const title = h.div(
    [h.DataAttribute("slot", "item-title"), h.Class(itemClassNames.title)],
    [props.title],
  );
  const content = [
    ...(props.media
      ? [
          h.div(
            [
              h.DataAttribute("slot", "item-media"),
              h.Class(itemClassNames.media),
            ],
            [props.media],
          ),
        ]
      : []),
    h.div(
      [
        h.DataAttribute("slot", "item-content"),
        h.Class(itemClassNames.content),
      ],
      [
        props.href && props.linkTitleOnly ? link([title]) : title,
        ...(props.description === undefined
          ? []
          : [
              h.div(
                [
                  h.Id(descriptionId),
                  h.DataAttribute("slot", "item-description"),
                  h.Class(itemClassNames.description),
                ],
                [props.description],
              ),
            ]),
      ],
    ),
  ];
  const body =
    props.href && !props.linkTitleOnly
      ? link(content)
      : h.div(
          [
            h.DataAttribute("slot", "item-body"),
            h.Class(stylex.props(styles.body).className ?? ""),
          ],
          content,
        );
  return h.li(
    [
      h.Key(props.key),
      h.DataAttribute("slot", "item"),
      h.DataAttribute("variant", variant),
      h.Class(itemClassName(variant)),
      ...(props.attributes ?? []),
    ],
    [
      body,
      ...(props.action
        ? [
            h.div(
              [
                h.DataAttribute("slot", "item-actions"),
                h.Class(itemClassNames.actions),
              ],
              [props.action],
            ),
          ]
        : []),
    ],
  );
};

// An Item with an independent avatar/action slot and an expandable body.
export const itemDisclosure = <Message>(
  props: {
    key: string;
    variant?: ItemVariant;
    media: Html;
    summary: ReadonlyArray<Html>;
    trailing?: ReadonlyArray<Html>;
    toggle?: {
      label: string;
      onClick: Message;
      attributes?: ReadonlyArray<Attribute<Message>>;
    };
    panel?: Html;
  },
  h: HtmlBuilder<Message>,
): Html => {
  const panelId = `item-panel-${props.key}`;
  const { toggle, panel, variant = "default" } = props;
  return h.li(
    [
      h.Key(props.key),
      h.DataAttribute("slot", "item"),
      h.DataAttribute("variant", variant),
      h.Class(
        stylex.props(styles.item, variant === "outline" && styles.outline)
          .className ?? "",
      ),
    ],
    [
      h.div(
        [
          h.DataAttribute("slot", "item-header"),
          h.Class(stylex.props(styles.row).className ?? ""),
        ],
        [
          h.div(
            [
              h.DataAttribute("slot", "item-media"),
              h.Class(stylex.props(styles.media).className ?? ""),
            ],
            [props.media],
          ),
          toggle
            ? h.button(
                [
                  h.Type("button"),
                  h.DataAttribute("slot", "button"),
                  h.DataAttribute("item-disclosure", ""),
                  h.Class(
                    stylex.props(styles.summary, styles.disclosure).className ??
                      "",
                  ),
                  h.AriaLabel(toggle.label),
                  h.AriaExpanded(panel !== undefined),
                  ...(panel ? [h.AriaControls(panelId)] : []),
                  h.OnClick(toggle.onClick),
                  ...(toggle.attributes ?? []),
                ],
                [...props.summary],
              )
            : h.div(
                [h.Class(stylex.props(styles.summary).className ?? "")],
                [...props.summary],
              ),
          ...(props.trailing?.length
            ? [
                h.div(
                  [
                    h.DataAttribute("slot", "item-actions"),
                    h.Class(stylex.props(styles.trailing).className ?? ""),
                  ],
                  [...props.trailing],
                ),
              ]
            : []),
        ],
      ),
      ...(panel
        ? [
            h.section(
              [
                h.Id(panelId),
                h.DataAttribute("slot", "item-panel"),
                h.Class(stylex.props(styles.panel).className ?? ""),
              ],
              [panel],
            ),
          ]
        : []),
    ],
  );
};
