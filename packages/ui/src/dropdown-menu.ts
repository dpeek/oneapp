import { Menu } from "@foldkit/ui";
import * as stylex from "@stylexjs/stylex";
import { childAttributes, type Html, type HtmlBuilder } from "foldkit/html";
import { buttonClassName } from "./button.ts";
import { controls } from "./tokens.stylex.ts";

export const { Model, Message, init } = Menu;

const styles = stylex.create({
  trigger: {
    backgroundColor: { ":is([data-open])": controls.hover },
  },
  backdrop: { position: "fixed", inset: 0, zIndex: 49 },
  panel: {
    zIndex: 50,
    minInlineSize: "9rem",
    padding: "0.25rem",
    borderColor: controls.border,
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: controls.radius,
    backgroundColor: controls.popover,
    color: controls.foreground,
    boxShadow:
      "0 4px 6px -1px rgb(0 0 0 / 10%), 0 2px 4px -2px rgb(0 0 0 / 10%)",
  },
  item: {
    display: "flex",
    alignItems: "center",
    minBlockSize: "2rem",
    paddingInline: "0.5rem",
    borderRadius: controls.radius,
    fontSize: "0.875rem",
    cursor: "pointer",
  },
  label: { display: "inline-flex", alignItems: "center", gap: "0.5rem" },
  active: { backgroundColor: controls.hover },
  disabled: { opacity: 0.5, cursor: "default" },
  destructive: { color: "light-dark(#a42020, #ff9797)" },
});

export type Item<Action extends string> = Readonly<{
  action: Action;
  label: string;
  icon: Html;
  disabled?: boolean;
  destructive?: boolean;
}>;

// Crease dropdown styling on the installed Foldkit Menu behavior.
export const create = <Action extends string>() => {
  const menu = Menu.create<Action>();
  return {
    update: menu.update,
    view: <ParentMessage>(
      props: {
        model: typeof Model.Type;
        label: string;
        trigger: Html;
        disabled?: boolean;
        items: ReadonlyArray<Item<Action>>;
        toParentMessage: (message: typeof Message.Type) => ParentMessage;
      },
      h: HtmlBuilder<ParentMessage>,
    ): Html =>
      h.submodel({
        slotId: props.model.id,
        model: props.model,
        view: menu.view,
        viewInputs: {
          items: props.items.map(({ action }) => action),
          isItemDisabled: (_action, index) =>
            props.items[index]?.disabled === true,
          itemToConfig: (action, { isActive, isDisabled }) => {
            const item = props.items.find((item) => item.action === action)!;
            return {
              className:
                stylex.props(
                  styles.item,
                  isActive && styles.active,
                  isDisabled && styles.disabled,
                  item.destructive && styles.destructive,
                ).className ?? "",
              content: h.span(
                [h.Class(stylex.props(styles.label).className ?? "")],
                [item.icon, item.label],
              ),
            };
          },
          itemToSearchText: (action) =>
            props.items.find((item) => item.action === action)?.label ?? action,
          buttonContent: props.trigger,
          buttonClassName: [
            buttonClassName({
              variant: "ghost",
              size: "icon-sm",
              rounded: true,
            }),
            stylex.props(styles.trigger).className,
          ].join(" "),
          buttonAttributes: childAttributes([
            h.DataAttribute("slot", "button"),
          ]),
          isButtonDisabled: props.disabled,
          itemsClassName: stylex.props(styles.panel).className ?? "",
          backdropClassName: stylex.props(styles.backdrop).className ?? "",
          anchor: { placement: "bottom-start", gap: 4 },
          ariaLabel: props.label,
        },
        toParentMessage: props.toParentMessage,
      }),
  };
};
