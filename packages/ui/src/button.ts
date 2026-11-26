import { Button as ButtonPrimitive } from "@foldkit/ui";
import * as stylex from "@stylexjs/stylex";
import type {
  Attribute,
  ChildAttribute,
  Html,
  HtmlBuilder,
} from "foldkit/html";
import { controls } from "./tokens.stylex.ts";

const styles = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    minBlockSize: "2.75rem",
    paddingBlock: "0.5rem",
    paddingInline: "0.875rem",
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: controls.pillRadius,
    fontFamily: "inherit",
    fontSize: "0.9375rem",
    fontWeight: 600,
    lineHeight: 1.3,
    cursor: {
      default: "pointer",
      ':is(:disabled, [aria-disabled="true"])': "default",
    },
    outline: {
      default: null,
      ":focus-visible": `2px solid ${controls.focus}`,
    },
    outlineOffset: { default: null, ":focus-visible": 3 },
  },
  primary: {
    borderColor: "transparent",
    backgroundColor: {
      default: controls.primary,
      "@media (hover: hover)": {
        ':hover:not(:disabled, [aria-disabled="true"])': controls.primaryHover,
      },
    },
    color: controls.onPrimary,
    opacity: { default: 1, ':is(:disabled, [aria-disabled="true"])': 0.55 },
  },
  destructive: {
    borderColor: "transparent",
    backgroundColor: {
      default: controls.destructive,
      "@media (hover: hover)": {
        ':hover:not(:disabled, [aria-disabled="true"])':
          controls.destructiveHover,
      },
    },
    color: controls.onDestructive,
    opacity: { default: 1, ':is(:disabled, [aria-disabled="true"])': 0.55 },
  },
  outline: {
    borderColor: controls.border,
    backgroundColor: {
      default: controls.surface,
      "@media (hover: hover)": {
        ':hover:not(:disabled, [aria-disabled="true"])': controls.hover,
      },
    },
    color: {
      default: controls.foreground,
      ':is(:disabled, [aria-disabled="true"])': controls.mutedForeground,
    },
  },
  ghost: {
    borderColor: "transparent",
    backgroundColor: {
      default: "transparent",
      "@media (hover: hover)": {
        ':hover:not(:disabled, [aria-disabled="true"])': controls.hover,
      },
    },
    color: controls.mutedForeground,
    opacity: { default: 1, ':is(:disabled, [aria-disabled="true"])': 0.55 },
  },
  subtle: {
    borderColor: "transparent",
    backgroundColor: {
      default: controls.hover,
      ":hover:not(:disabled)": controls.selected,
    },
    color: controls.foreground,
    fontWeight: 500,
  },
  quiet: {
    borderColor: "transparent",
    textDecoration: "none",
    backgroundColor: {
      default: "transparent",
      "@media (hover: hover)": {
        ':hover:not(:disabled, [aria-disabled="true"], [aria-current="page"], [aria-pressed="true"])':
          controls.hover,
      },
      ':is([aria-current="page"], [aria-pressed="true"])': controls.selected,
    },
    color: {
      default: controls.mutedForeground,
      ':is([aria-current="page"], [aria-pressed="true"])': controls.foreground,
    },
    fontWeight: {
      default: 500,
      ':is([aria-current="page"], [aria-pressed="true"])': 600,
    },
    opacity: { default: 1, ':is(:disabled, [aria-disabled="true"])': 0.55 },
  },
  sm: {
    minBlockSize: "2rem",
    gap: "0.25rem",
    paddingBlock: "0.25rem",
    paddingInline: "0.625rem",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
  },
  smallTouchTarget: {
    minBlockSize: { default: "2rem", "@media (pointer: coarse)": "2.75rem" },
    minInlineSize: { "@media (pointer: coarse)": "2.75rem" },
  },
  icon: {
    inlineSize: "2.75rem",
    flexShrink: 0,
    padding: 0,
  },
  "icon-sm": {
    inlineSize: "2rem",
    minBlockSize: "2rem",
    flexShrink: 0,
    paddingBlock: 0,
    paddingInline: 0,
  },
});

type ButtonProps<Message> = Readonly<{
  children: ReadonlyArray<Html | string>;
  ariaLabel?: string;
  dialogId?: string;
  variant?:
    "primary" | "destructive" | "outline" | "ghost" | "quiet" | "subtle";
  size?: "sm" | "icon" | "icon-sm";
  type?: "button" | "submit";
  disabled?: boolean;
  /** Keeps a disabled action in the tab order while it reports progress. */
  focusableWhenDisabled?: boolean;
  onClick?: Message;
  attributes?: ReadonlyArray<Attribute<Message> | ChildAttribute>;
}>;

export const buttonClassName = (
  props: Pick<ButtonProps<never>, "variant" | "size">,
) =>
  stylex.props(
    styles.base,
    styles[props.variant ?? "primary"],
    props.size && styles[props.size],
    (props.variant === "quiet" || props.variant === "subtle") &&
      props.size === "sm" &&
      styles.smallTouchTarget,
  ).className ?? "";

export const button = <Message>(
  props: ButtonProps<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  ButtonPrimitive.view(
    {
      type:
        props.disabled && props.focusableWhenDisabled
          ? "button"
          : (props.type ?? "button"),
      isDisabled: props.disabled ?? false,
      ...(props.onClick === undefined ? {} : { onClick: props.onClick }),
      toView: ({ button: attributes }) =>
        h.button(
          [
            ...attributes,
            ...(props.attributes ?? []),
            h.Disabled(props.disabled === true && !props.focusableWhenDisabled),
            h.DataAttribute("slot", "button"),
            ...(props.ariaLabel ? [h.AriaLabel(props.ariaLabel)] : []),
            ...(props.dialogId
              ? [h.AriaHasPopup("dialog"), h.AriaControls(props.dialogId)]
              : []),
            h.Class(buttonClassName(props)),
          ],
          [...props.children],
        ),
    },
    h,
  );
