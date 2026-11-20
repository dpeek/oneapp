import * as stylex from "@stylexjs/stylex";
import { buttonClassName } from "./button.ts";
import { controls } from "./tokens.stylex.ts";

const enter = stylex.keyframes({
  from: { opacity: 0, transform: "scale(0.95) translateY(4px)" },
  to: { opacity: 1, transform: "scale(1) translateY(0)" },
});

const styles = stylex.create({
  root: {
    display: "grid",
    gridTemplateAreas: {
      default: '"selection separator actions close"',
      "@media (max-width: 32rem)": '"selection close" "actions actions"',
    },
    gridTemplateColumns: {
      default: "auto auto minmax(0, auto) auto",
      "@media (max-width: 32rem)": "minmax(0, 1fr) auto",
    },
    alignItems: "center",
    gap: "0.5rem",
    boxSizing: "border-box",
    inlineSize: "max-content",
    maxInlineSize: "100%",
    paddingBlock: "0.375rem",
    paddingInline: "0.5rem",
    borderColor: controls.border,
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: "0.75rem",
    backgroundColor: controls.surface,
    boxShadow: "0 12px 28px rgb(0 0 0 / 18%)",
    animationName: {
      default: enter,
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    animationDuration: "160ms",
    animationTimingFunction: "ease-out",
  },
  selection: {
    gridArea: "selection",
    justifySelf: "start",
    paddingBlock: "0.25rem",
    paddingInline: "0.5rem",
    borderColor: controls.border,
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: controls.radius,
    fontSize: "0.875rem",
    fontWeight: 500,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  separator: {
    gridArea: "separator",
    backgroundColor: controls.border,
    blockSize: "1.5rem",
    inlineSize: "1px",
    display: { default: "block", "@media (max-width: 32rem)": "none" },
  },
  group: {
    gridArea: "actions",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.25rem",
  },
  destructive: {
    color: { ":is([data-destructive])": "light-dark(#a42020, #ff9797)" },
  },
  close: { gridArea: "close", justifySelf: "end" },
});

type Action = Readonly<{
  label: string;
  title?: string;
  destructive?: boolean;
  onSelect: () => void;
}>;

// The DOM adapter keeps selection state with the Vault reader.
export const actionBar = (props: {
  label: string;
  actions: readonly Action[];
  menu?: HTMLElement;
  onClear: () => void;
}) => {
  const element = document.createElement("div");
  element.dataset.slot = "action-bar";
  element.className = stylex.props(styles.root).className ?? "";
  element.setAttribute("role", "toolbar");
  element.setAttribute("aria-label", props.label);
  element.setAttribute("aria-orientation", "horizontal");

  const selection = document.createElement("span");
  selection.dataset.slot = "action-bar-selection";
  selection.className = stylex.props(styles.selection).className ?? "";
  selection.setAttribute("role", "status");

  const separator = document.createElement("span");
  separator.dataset.slot = "action-bar-separator";
  separator.className = stylex.props(styles.separator).className ?? "";
  separator.setAttribute("aria-hidden", "true");

  const group = document.createElement("div");
  group.dataset.slot = "action-bar-group";
  group.className = stylex.props(styles.group).className ?? "";
  const actions = props.actions.map(
    ({ label, title, destructive, onSelect }, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.tabIndex = !props.menu && index === 0 ? 0 : -1;
      button.dataset.slot = "action-bar-item";
      button.textContent = label;
      if (title) button.title = title;
      button.className = buttonClassName({ variant: "ghost", size: "sm" });
      if (destructive) {
        button.dataset.destructive = "";
        button.className += ` ${stylex.props(styles.destructive).className ?? ""}`;
      }
      button.addEventListener("click", onSelect);
      return button;
    },
  );
  if (props.menu) group.append(props.menu);
  group.append(...actions);

  const close = document.createElement("button");
  close.type = "button";
  close.tabIndex = !props.menu && actions.length === 0 ? 0 : -1;
  close.dataset.slot = "action-bar-close";
  close.className = `${buttonClassName({ variant: "ghost", size: "icon-sm" })} ${stylex.props(styles.close).className ?? ""}`;
  close.textContent = "×";
  close.title = "Clear selection";
  close.setAttribute("aria-label", "Clear selection");
  close.addEventListener("click", props.onClear);
  element.append(selection, separator, group, close);

  const buttons = () => [
    ...group.querySelectorAll<HTMLButtonElement>(
      'button[data-slot="action-bar-item"], button[aria-haspopup="menu"]',
    ),
    close,
  ];
  element.addEventListener("focusin", (event) => {
    const controls = buttons();
    if (controls.some((button) => event.target === button))
      for (const button of controls)
        button.tabIndex = button === event.target ? 0 : -1;
  });
  element.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    const controls = buttons();
    const index = controls.findIndex((button) => event.target === button);
    if (index < 0) return;
    let target: number;
    switch (event.key) {
      case "Home":
        target = 0;
        break;
      case "End":
        target = controls.length - 1;
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        const rtl = getComputedStyle(element).direction === "rtl";
        const step = (event.key === "ArrowRight") !== rtl ? 1 : -1;
        target = (index + step + controls.length) % controls.length;
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    controls[target]?.focus();
  });

  return {
    element,
    setCount: (count: number) => {
      selection.textContent = `${count} selected`;
    },
  };
};
