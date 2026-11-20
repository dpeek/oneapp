import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";
import { controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  menu: {
    display: "grid",
    gap: "0.25rem",
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  tabs: {
    display: "inline-flex",
    gap: "0.125rem",
    maxInlineSize: "100%",
    borderRadius: controls.radius,
    padding: 3,
    backgroundColor: controls.hover,
  },
  lineTabs: {
    gap: "0.25rem",
    borderRadius: 0,
    padding: 0,
    backgroundColor: "transparent",
  },
  link: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    borderRadius: controls.radius,
    color: controls.mutedForeground,
    textDecoration: "none",
    fontSize: "0.875rem",
    fontWeight: 500,
    outlineOffset: { ":focus-visible": -2 },
    backgroundColor: {
      default: "transparent",
      "@media (hover: hover)": { ":hover": controls.hover },
    },
  },
  sidebarLink: {
    justifyContent: "space-between",
    minBlockSize: "2rem",
    paddingInline: "0.5rem",
    lineHeight: "1.25rem",
    fontWeight: 400,
  },
  sidebarSelected: {
    color: controls.primary,
    backgroundColor: controls.hover,
    fontWeight: 500,
  },
  sidebarButton: {
    boxSizing: "border-box",
    inlineSize: "100%",
    paddingBlock: 0,
    borderStyle: "none",
    fontFamily: "inherit",
    textAlign: "start",
    cursor: "pointer",
    outline: { ":focus-visible": `2px solid ${controls.focus}` },
  },
  iconLabel: { display: "inline-flex", alignItems: "center", gap: "0.5rem" },
  tabLink: {
    minBlockSize: "2rem",
    paddingInline: "0.75rem",
  },
  tabSelected: {
    color: controls.foreground,
    backgroundColor: controls.surface,
    boxShadow: "0 1px 3px rgb(0 0 0 / 12%)",
  },
  lineTab: {
    position: "relative",
    paddingInline: "0.5rem",
    backgroundColor: "transparent",
    color: {
      default: controls.mutedForeground,
      "@media (hover: hover)": { ":hover": controls.foreground },
    },
  },
  lineTabSelected: {
    color: controls.foreground,
    "::after": {
      content: '""',
      position: "absolute",
      insetInline: 0,
      insetBlockEnd: 0,
      blockSize: 2,
      backgroundColor: "currentColor",
    },
  },
  badge: {
    flexShrink: 0,
    display: "inline-grid",
    placeItems: "center",
    boxSizing: "border-box",
    minInlineSize: "1.125rem",
    minBlockSize: "1.125rem",
    paddingInline: "0.3rem",
    borderRadius: "9999px",
    backgroundColor: controls.primary,
    color: controls.onPrimary,
    fontSize: "0.6875rem",
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
  },
});

type Destination = Readonly<{
  href: string;
  label: string;
  icon?: Html;
  current?: boolean;
  unread?: number;
}>;

export const sidebarClassNames = {
  list: stylex.props(styles.menu).className ?? "",
  label: stylex.props(styles.iconLabel).className ?? "",
};

export const sidebarItemClassName = (current: boolean, asButton = false) =>
  stylex.props(
    styles.link,
    styles.sidebarLink,
    asButton && styles.sidebarButton,
    current && styles.sidebarSelected,
  ).className ?? "";

export const unreadBadge = <Message>(
  h: HtmlBuilder<Message>,
  count: number,
  label?: string,
): Html =>
  h.span(
    [
      h.DataAttribute("slot", "navigation-badge"),
      h.Class(stylex.props(styles.badge).className ?? ""),
      ...(label
        ? [h.Role("img"), h.AriaLabel(label), h.Title(label)]
        : [h.AriaHidden(true)]),
    ],
    [count > 99 ? "99+" : String(count)],
  );

// Crease's Sidebar menu and Tabs visuals for URL-driven destinations.
export const navigationLinks = <Message>(
  props: {
    label: string;
    destinations: ReadonlyArray<Destination>;
    variant: "sidebar" | "tabs" | "tabs-line";
  },
  h: HtmlBuilder<Message>,
): Html => {
  const sidebar = props.variant === "sidebar";
  const line = props.variant === "tabs-line";
  const selected = line ? styles.lineTabSelected : styles.tabSelected;
  return h.nav(
    [h.AriaLabel(props.label)],
    [
      h.ul(
        [
          h.Class(
            sidebar
              ? sidebarClassNames.list
              : (stylex.props(styles.menu, styles.tabs, line && styles.lineTabs)
                  .className ?? ""),
          ),
        ],
        props.destinations.map(({ href, label, icon, current, unread }) =>
          h.li(
            [h.Key(href)],
            [
              h.a(
                [
                  h.Href(href),
                  h.DataAttribute("slot", "navigation-link"),
                  ...(current
                    ? [h.AriaCurrent(sidebar ? "true" : "page")]
                    : []),
                  ...(unread
                    ? [h.AriaLabel(`${label}, ${unread} unread`)]
                    : []),
                  h.Class(
                    sidebar
                      ? sidebarItemClassName(current === true)
                      : (stylex.props(
                          styles.link,
                          styles.tabLink,
                          line && styles.lineTab,
                          current && selected,
                        ).className ?? ""),
                  ),
                ],
                [
                  icon
                    ? h.span([h.Class(sidebarClassNames.label)], [icon, label])
                    : label,
                  ...(unread ? [unreadBadge(h, unread)] : []),
                ],
              ),
            ],
          ),
        ),
      ),
    ],
  );
};
