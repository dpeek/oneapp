import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";
import { buttonClassName } from "./button.ts";
import { controls } from "./tokens.stylex.ts";
import { viewSwitchButton, viewSwitchGroupClassName } from "./view-switch.ts";

const styles = stylex.create({
  menuReset: {
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  menu: { display: "grid", gap: "0.25rem" },
  tabs: {
    display: "inline-flex",
    gap: "0.125rem",
    maxInlineSize: "100%",
    borderRadius: controls.radius,
    padding: 3,
    backgroundColor: controls.hover,
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
    color: controls.foreground,
    backgroundColor: {
      default: controls.selected,
      "@media (hover: hover)": { ":hover": controls.selected },
    },
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
  list: stylex.props(styles.menuReset, styles.menu).className ?? "",
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
    variant: "sidebar" | "tabs" | "pills";
  },
  h: HtmlBuilder<Message>,
): Html => {
  const sidebar = props.variant === "sidebar";
  const pills = props.variant === "pills";
  return h.nav(
    [h.AriaLabel(props.label)],
    [
      h.ul(
        [
          h.Class(
            sidebar
              ? sidebarClassNames.list
              : pills
                ? `${stylex.props(styles.menuReset).className ?? ""} ${viewSwitchGroupClassName}`
                : (stylex.props(styles.menuReset, styles.tabs).className ?? ""),
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
                      : pills
                        ? buttonClassName(viewSwitchButton)
                        : (stylex.props(
                            styles.link,
                            styles.tabLink,
                            current && styles.tabSelected,
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
