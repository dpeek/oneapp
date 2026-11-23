// Adapted from CreaseUI (MIT), revision b11a974af28917ae6fea67cbf9ade89d8a3c464c.
// See ../THIRD_PARTY_NOTICES.md for source and license.
import * as stylex from "@stylexjs/stylex";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { Option } from "effect";

import { outlineIcon } from "./icons.ts";
import { buttonClassName } from "./button.ts";
import { controls } from "./tokens.stylex.ts";
import {
  type Entry,
  type Message,
  type Model,
  type Position,
  type Variant,
  Message as ToastMessages,
  stackLayout,
  contentMount,
  viewportMount,
  viewportId,
  focusTargetId,
} from "./toast-state.ts";
import type { StaticStyles } from "@stylexjs/stylex";

export {
  Model,
  Message,
  OutMessage,
  Entry,
  Position,
  Variant,
  init,
  update,
  show,
  dismiss,
  dismissAll,
  updateToast,
  success,
  error,
  warning,
  info,
  plain,
} from "./toast-state.ts";
export type { ToastInput, ShowInput, UpdateInput } from "./toast-state.ts";

const className = (...styles: ReadonlyArray<StaticStyles | undefined>) =>
  stylex.props(...styles).className ?? "";

const styles = stylex.create({
  action: {
    paddingInline: "0.75rem",
    backgroundColor: {
      default: "transparent",
      "@media (hover: hover)": { default: null, ":hover": controls.hover },
    },
    flexShrink: 0,
  },
  body: {
    gap: "0.25rem",
    display: "grid",
    flexGrow: 1,
    overflowWrap: "anywhere",
    minWidth: 0,
  },
  description: {
    color: controls.mutedForeground,
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
  },
  dismiss: {
    padding: "0.25rem",
    color: {
      default: controls.mutedForeground,
      "@media (hover: hover)": { default: null, ":hover": controls.foreground },
    },
    opacity: { default: 0.7, ":focus": 1 },
    position: "absolute",
    right: "0.5rem",
    top: "0.5rem",
  },
  icon: { flexShrink: 0, height: "1rem", marginTop: "0.125rem", width: "1rem" },
  title: { fontSize: "0.875rem", fontWeight: 600, lineHeight: "1.25rem" },
  toast: {
    boxSizing: "border-box",
    borderColor: controls.border,
    borderRadius: "0.75rem",
    borderStyle: "solid",
    borderWidth: 1,
    backgroundColor: controls.popover,
    boxShadow: "0 4px 12px rgb(0 0 0 / 15%)",
    color: controls.foreground,
    pointerEvents: "auto",
    position: "absolute",
    transitionDuration: {
      default: "200ms",
      "@media (prefers-reduced-motion: reduce)": "0ms",
    },
    transitionProperty: "transform, opacity, height",
    transitionTimingFunction: "ease",
    left: 0,
    width: "100%",
    "::after": {
      content: "''",
      position: "absolute",
      height: 13,
      left: 0,
      width: "100%",
    },
  },
  viewport: {
    outline: {
      default: "none",
      ":focus-visible": `2px solid ${controls.focus}`,
    },
    outlineOffset: 4,
    pointerEvents: "none",
    position: "fixed",
    zIndex: 100,
    maxHeight:
      "calc(100dvh - 2rem - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - var(--bottom-nav-size, 0px))",
    maxWidth: "24rem",
    width: {
      default: "calc(100% - 2rem)",
      "@media (min-width: 640px)": "100%",
    },
  },
  stage: { position: "relative", width: "100%" },
  content: {
    boxSizing: "border-box",
    padding: "1rem",
    gap: "0.75rem",
    overflow: "hidden",
    alignItems: "flex-start",
    display: "flex",
    position: "relative",
    transitionDuration: {
      default: "150ms",
      "@media (prefers-reduced-motion: reduce)": "0ms",
    },
    transitionProperty: "opacity",
    transitionTimingFunction: "ease",
    paddingRight: "3rem",
  },
  entryTop: { transformOrigin: "top", top: 0, "::after": { bottom: "100%" } },
  entryBottom: {
    transformOrigin: "bottom",
    bottom: 0,
    "::after": { top: "100%" },
  },
  limited: { pointerEvents: "none" },
  swipeEnabled: { touchAction: "pan-y" },
  swiping: {
    cursor: "grabbing",
    transitionDuration: "0ms",
    userSelect: "none",
  },
  front: { "::after": { display: "none" } },
  expanded: { overflowY: "auto" },
  viewportLeft: { left: "1rem" },
  viewportCenter: { transform: "translateX(-50%)", left: "50%" },
  viewportRight: { right: "1rem" },
  viewportTop: { top: "max(1rem, env(safe-area-inset-top, 0px))" },
  viewportBottomEdge: {
    bottom:
      "calc(1rem + env(safe-area-inset-bottom, 0px) + var(--bottom-nav-size, 0px))",
  },
  visuallyClosed: { opacity: 0 },
});

const variantIcon = <Msg>(
  variant: Variant,
  h: HtmlBuilder<Msg>,
): Html | undefined => {
  const paths = {
    Success: ["M22 11v1a10 10 0 1 1-5.93-9.14", "m9 11 3 3L22 4"],
    Error: [
      "M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86Z",
      "m9 9 6 6m0-6-6 6",
    ],
    Warning: ["m12 3 10 18H2Z", "M12 9v4m0 4h.01"],
    Info: ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0", "M12 11v6m0-10h.01"],
  };
  return variant === "Default"
    ? undefined
    : h.span(
        [h.Class(className(styles.icon))],
        [outlineIcon(h, paths[variant])],
      );
};

const POSITION_ORDER: ReadonlyArray<Position> = [
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

const positionStyle = (position: Position): ReadonlyArray<StaticStyles> => {
  switch (position) {
    case "top-left":
      return [styles.viewportLeft, styles.viewportTop];
    case "top-center":
      return [styles.viewportCenter, styles.viewportTop];
    case "top-right":
      return [styles.viewportRight, styles.viewportTop];
    case "bottom-left":
      return [styles.viewportLeft, styles.viewportBottomEdge];
    case "bottom-center":
      return [styles.viewportCenter, styles.viewportBottomEdge];
    case "bottom-right":
      return [styles.viewportRight, styles.viewportBottomEdge];
  }
};

export type ToastProps<Msg> = Readonly<{
  model: Model;
  toParentMessage: (message: Message) => Msg;
  ariaLabel?: string;
  pausePolicy?: "none" | "pointer";
  layoutStyle?: StaticStyles;
  entryLayoutStyle?: StaticStyles;
  position?: Position;
  stacked?: boolean;
  expanded?: boolean;
}>;

/** Mirrors the upstream Toast view's animation attributes so the entry
 *  participates in the primitive's enter/leave lifecycle. */
const animationAttributes = <Msg>(
  entry: Entry,
  h: HtmlBuilder<Msg>,
): ReadonlyArray<Attribute<Msg>> => {
  switch (entry.animation.transitionState) {
    case "EnterStart":
      return [
        h.DataAttribute("closed", ""),
        h.DataAttribute("enter", ""),
        h.DataAttribute("transition", ""),
      ];
    case "EnterAnimating":
      return [h.DataAttribute("enter", ""), h.DataAttribute("transition", "")];
    case "LeaveStart":
      return [h.DataAttribute("leave", ""), h.DataAttribute("transition", "")];
    case "LeaveAnimating":
      return [
        h.DataAttribute("closed", ""),
        h.DataAttribute("leave", ""),
        h.DataAttribute("transition", ""),
      ];
    default:
      return [];
  }
};

/** `data-closed` phases (enter start, leave end) fade the entry via the
 *  existing opacity/transform transition. */
const entryView = <Msg>(
  item: ReturnType<typeof stackLayout>["entries"][number],
  position: Position,
  expanded: boolean,
  props: ToastProps<Msg>,
  h: HtmlBuilder<Msg>,
): Html => {
  const { entry, limited, behind } = item;
  return h.article(
    [
      h.Key(entry.id),
      h.Id(entry.id),
      h.Role(entry.payload.variant === "Error" ? "alert" : "status"),
      h.AriaAtomic(true),
      h.DataAttribute("slot", "toast-entry"),
      h.DataAttribute("toast-focus-key", entry.id),
      h.DataAttribute("variant", entry.payload.variant.toLowerCase()),
      h.DataAttribute("paused", String(entry.isHovered)),
      h.Inert(limited),
      ...(item.swiping ? [h.DataAttribute("swiping", "")] : []),
      ...(item.swipeDirection
        ? [
            h.DataAttribute(
              "swipe-direction",
              item.swipeDirection.toLowerCase(),
            ),
          ]
        : []),
      ...(limited ? [h.DataAttribute("limited", ""), h.AriaHidden(true)] : []),
      ...(expanded ? [h.DataAttribute("expanded", "")] : []),
      h.Style(item.style),
      ...animationAttributes(entry, h),
      h.Class(
        className(
          styles.toast,
          position.startsWith("top") ? styles.entryTop : styles.entryBottom,
          limited ? styles.limited : undefined,
          Option.isSome(props.model.maybeSwipeConfig)
            ? styles.swipeEnabled
            : undefined,
          item.swiping ? styles.swiping : undefined,
          item.index === 0 ? styles.front : undefined,
          props.entryLayoutStyle,
        ),
      ),
    ],
    [
      h.div(
        [
          h.DataAttribute("slot", "toast-content"),
          ...(behind ? [h.DataAttribute("behind", "")] : []),
          ...(expanded ? [h.DataAttribute("expanded", "")] : []),
          h.OnMount(contentMount(entry.id, props.toParentMessage)),
          h.Class(
            className(
              styles.content,
              behind ? styles.visuallyClosed : undefined,
            ),
          ),
        ],
        [
          ...(variantIcon(entry.payload.variant, h) === undefined
            ? []
            : [variantIcon(entry.payload.variant, h)!]),
          h.div(
            [h.Class(className(styles.body))],
            [
              h.div([h.Class(className(styles.title))], [entry.payload.title]),
              ...(entry.payload.description === undefined
                ? []
                : [
                    h.div(
                      [h.Class(className(styles.description))],
                      [entry.payload.description],
                    ),
                  ]),
            ],
          ),
          ...(entry.payload.actionLabel === undefined
            ? []
            : [
                h.button(
                  [
                    h.Type("button"),
                    h.DataAttribute("slot", "button"),
                    h.Id(focusTargetId(entry.id)),
                    h.OnClick(
                      props.toParentMessage(
                        ToastMessages.ActivatedToastAction({ id: entry.id }),
                      ),
                    ),
                    h.Class(
                      `${buttonClassName({ variant: "outline", size: "sm" })} ${className(styles.action)}`,
                    ),
                  ],
                  [entry.payload.actionLabel],
                ),
              ]),
          h.button(
            [
              h.Type("button"),
              h.DataAttribute("slot", "button"),
              h.AriaLabel("Dismiss notification"),
              h.Id(
                entry.payload.actionLabel === undefined
                  ? focusTargetId(entry.id)
                  : `${entry.id}-dismiss`,
              ),
              h.OnClick(
                props.toParentMessage(
                  ToastMessages.Dismissed({ entryId: entry.id }),
                ),
              ),
              h.Class(
                `${buttonClassName({ variant: "ghost", size: "icon-sm" })} ${className(styles.dismiss)}`,
              ),
            ],
            [outlineIcon(h, ["m6 6 12 12m0-12L6 18"])],
          ),
        ],
      ),
    ],
  );
};

export const toast = <Msg>(
  props: ToastProps<Msg>,
  h: HtmlBuilder<Msg>,
): Html => {
  const fallback = props.position ?? props.model.position;
  const entryPosition = (entry: Entry): Position =>
    entry.payload.position ?? fallback;
  const positions = POSITION_ORDER.filter(
    (position) =>
      Object.hasOwn(props.model.focusRecovery, position) ||
      props.model.entries.some((entry) => entryPosition(entry) === position),
  );
  return h.div(
    [h.Key(props.model.id), h.DataAttribute("slot", "toast-root")],
    (positions.length === 0 ? [fallback] : positions).map((position) => {
      const expanded =
        props.stacked === false ||
        props.expanded === true ||
        props.model.hoveredPositions.includes(position) ||
        props.model.focusedPositions.includes(position);
      const layout = stackLayout(props.model, position, expanded, fallback);
      return h.section(
        [
          h.AriaLabel(props.ariaLabel ?? "Notifications"),
          h.Id(viewportId(props.model.id, position)),
          h.AriaLive("polite"),
          h.Key(position),
          h.Tabindex(-1),
          h.OnMount(
            viewportMount(
              position,
              fallback,
              props.model.id,
              props.toParentMessage,
              Option.isSome(props.model.maybeSwipeConfig),
              props.pausePolicy !== "none",
            ),
          ),
          h.DataAttribute("slot", "toast"),
          h.DataAttribute("position", position),
          h.Style({ height: `${layout.height}px` }),
          h.Class(
            className(
              styles.viewport,
              ...positionStyle(position),
              expanded && layout.height > props.model.viewportHeight - 32
                ? styles.expanded
                : undefined,
              props.layoutStyle,
            ),
          ),
        ],
        [
          h.div(
            [
              h.Class(className(styles.stage)),
              h.Style({ height: `${layout.height}px` }),
            ],
            layout.entries.map((item) =>
              entryView(item, position, expanded, props, h),
            ),
          ),
        ],
      );
    }),
  );
};
