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

type AlertContent = Readonly<{
  message: string | null;
  severity: AlertSeverity;
  announcement: AlertAnnouncement;
  messageId?: string;
}>;

const rootClassName = (severity: AlertSeverity, empty: boolean) =>
  stylex.props(styles.root, styles[severity], empty && styles.empty)
    .className ?? "";
const iconClassName = stylex.props(styles.icon).className ?? "";
const titleClassName = stylex.props(styles.title).className ?? "";

export const alert = <Message>(
  {
    message,
    severity,
    announcement,
    messageId,
    action,
  }: AlertContent & Readonly<{ action?: Html | undefined }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.DataAttribute("slot", "alert"),
      h.DataAttribute("severity", severity),
      h.Class(rootClassName(severity, !message)),
    ],
    [
      message
        ? h.div(
            [
              h.Key("icon"),
              h.DataAttribute("slot", "alert-icon"),
              h.Class(iconClassName),
            ],
            [outlineIcon(h, icons[severity])],
          )
        : h.empty,
      h.div(
        [
          h.Key("title"),
          h.DataAttribute("slot", "alert-title"),
          ...(messageId ? [h.Id(messageId)] : []),
          ...(announcement === "static"
            ? []
            : [
                h.Role(announcement),
                h.AriaLive(announcement === "alert" ? "assertive" : "polite"),
                h.AriaAtomic(true),
              ]),
          h.Class(titleClassName),
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

// Shared Alert styling for callers that render directly into the DOM.
export const createAlert = ({
  message,
  severity,
  announcement,
  messageId,
}: AlertContent & { message: string }) => {
  const element = document.createElement("div");
  element.dataset.slot = "alert";
  element.dataset.severity = severity;
  element.className = rootClassName(severity, false);

  const ns = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(ns, "svg");
  icon.dataset.slot = "alert-icon";
  icon.setAttribute("class", iconClassName);
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  for (const data of icons[severity]) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", data);
    icon.append(path);
  }

  const title = document.createElement("div");
  title.dataset.slot = "alert-title";
  title.className = titleClassName;
  title.textContent = message;
  if (messageId) title.id = messageId;
  if (announcement !== "static") {
    title.setAttribute("role", announcement);
    title.setAttribute(
      "aria-live",
      announcement === "alert" ? "assertive" : "polite",
    );
    title.setAttribute("aria-atomic", "true");
  }
  element.append(icon, title);
  return element;
};
