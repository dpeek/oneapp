// Adapted from CreaseUI's StyleX Alert. See ../THIRD_PARTY_NOTICES.md.
import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";
import { outlineIcon } from "./icons.ts";
import { alertColors, controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  root: {
    display: "grid",
    gridTemplateColumns: "1rem minmax(0, 1fr)",
    alignItems: "start",
    rowGap: "0.125rem",
    columnGap: "0.75rem",
    boxSizing: "border-box",
    inlineSize: "100%",
    paddingBlock: "0.75rem",
    paddingInline: "1rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: controls.border,
    borderRadius: controls.radius,
    backgroundColor: controls.surface,
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
  },
  empty: {
    position: "absolute",
    inlineSize: 1,
    blockSize: 1,
    paddingBlock: 0,
    paddingInline: 0,
    borderWidth: 0,
    overflow: "hidden",
    clipPath: "inset(50%)",
  },
  info: { color: alertColors.info },
  success: { color: alertColors.success },
  warning: { color: alertColors.warning },
  error: { color: alertColors.error },
  icon: {
    gridColumnStart: "1",
    gridRow: "span 2",
    inlineSize: "1rem",
    blockSize: "1rem",
  },
  title: {
    gridColumnStart: "2",
    fontWeight: 500,
    letterSpacing: "-0.025em",
    overflowWrap: "anywhere",
  },
  action: { gridColumnStart: "2", justifySelf: "start" },
});

const icons = {
  info: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 11v5m0-8h.01"],
  success: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "m8 12 3 3 5-6"],
  warning: ["m12 3 10 17H2L12 3Z", "M12 9v4m0 3h.01"],
  error: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 8v4m0 4h.01"],
};

export type AlertSeverity = keyof typeof icons;
export type AlertAnnouncement = "static" | "status" | "alert";

export const alert = <Message>(
  {
    message,
    severity,
    announcement,
    action,
  }: Readonly<{
    message: string | null;
    severity: AlertSeverity;
    announcement: AlertAnnouncement;
    action?: Html | undefined;
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.DataAttribute("slot", "alert"),
      h.DataAttribute("severity", severity),
      h.Class(
        stylex.props(styles.root, styles[severity], !message && styles.empty)
          .className ?? "",
      ),
    ],
    [
      message
        ? h.div(
            [
              h.Key("icon"),
              h.DataAttribute("slot", "alert-icon"),
              h.Class(stylex.props(styles.icon).className ?? ""),
            ],
            [outlineIcon(h, icons[severity])],
          )
        : h.empty,
      h.div(
        [
          h.Key("title"),
          h.DataAttribute("slot", "alert-title"),
          ...(announcement === "static"
            ? []
            : [
                h.Role(announcement),
                h.AriaLive(announcement === "alert" ? "assertive" : "polite"),
                h.AriaAtomic(true),
              ]),
          h.Class(stylex.props(styles.title).className ?? ""),
        ],
        message ? [message] : [],
      ),
      ...(message && action
        ? [
            h.div(
              [
                h.Key("action"),
                h.DataAttribute("slot", "alert-action"),
                h.Class(stylex.props(styles.action).className ?? ""),
              ],
              [action],
            ),
          ]
        : []),
    ],
  );
