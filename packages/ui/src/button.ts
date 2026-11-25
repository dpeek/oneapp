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
    borderRadius: controls.radius,
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
  sm: {
    minBlockSize: "2rem",
    gap: "0.25rem",
    paddingBlock: "0.25rem",
    paddingInline: "0.625rem",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
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
  rounded: { borderRadius: "9999px" },
});

type ButtonProps<Message> = Readonly<{
  children: ReadonlyArray<Html | string>;
  ariaLabel?: string;
  dialogId?: string;
  variant?: "primary" | "destructive" | "outline" | "ghost";
  size?: "sm" | "icon" | "icon-sm";
  rounded?: boolean;
  type?: "button" | "submit";
  disabled?: boolean;
  /** Keeps a disabled action in the tab order while it reports progress. */
  focusableWhenDisabled?: boolean;
  onClick?: Message;
  attributes?: ReadonlyArray<Attribute<Message> | ChildAttribute>;
}>;

export const buttonClassName = (
  props: Pick<ButtonProps<never>, "variant" | "size" | "rounded">,
) =>
  stylex.props(
    styles.base,
    styles[props.variant ?? "primary"],
    props.size && styles[props.size],
    props.rounded === true && styles.rounded,
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
