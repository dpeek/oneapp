import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";

const styles = stylex.create({
  group: {
    display: "flex",
    alignItems: "stretch",
  },
});

const groupClassName = stylex.props(styles.group).className ?? "";

export const createButtonGroup = (children: readonly HTMLElement[]) => {
  const element = document.createElement("div");
  element.dataset.slot = "button-group";
  element.setAttribute("role", "group");
  element.className = groupClassName;
  element.append(...children);
  return element;
};

export const buttonGroup = <Message>(
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
  label?: string,
): Html =>
  h.div(
    [
      h.Role("group"),
      ...(label ? [h.AriaLabel(label)] : []),
      h.DataAttribute("slot", "button-group"),
      h.Class(groupClassName),
    ],
    [...children],
  );
