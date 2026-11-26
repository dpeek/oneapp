import { Combobox } from "@foldkit/ui";
import * as stylex from "@stylexjs/stylex";
import { Option } from "effect";
import type { HtmlBuilder } from "foldkit/html";
import { mapMessage } from "foldkit/mount";
import { inputClassName } from "./field.ts";
import { outlineIcon } from "./icons.ts";
import { controls } from "./tokens.stylex.ts";

export const { Message } = Combobox;
export const { Model } = Combobox.Multi;
const combobox = Combobox.Multi.create<string>();
export const { update } = combobox;
export const init = (id: string) =>
  combobox.open(Combobox.Multi.init({ id })).model;

const styles = stylex.create({
  list: {
    marginBlockStart: "0.25rem",
    maxBlockSize: "min(15rem, 35dvh)",
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  option: {
    display: "grid",
    gridTemplateColumns: "1rem minmax(0, 1fr)",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.375rem 0.5rem",
    borderRadius: controls.radius,
    backgroundColor: {
      ":hover": controls.hover,
      ":is([data-active])": controls.hover,
    },
    overflowWrap: "anywhere",
    cursor: "pointer",
  },
  empty: { padding: "0.5rem", color: controls.mutedForeground },
});

type Item = Readonly<{ id: string; name: string }>;

// Crease's multi-select Combobox keeps selections in the parent. The list is
// inline here so it can share the outer popover with the category buttons.
export const view = <ParentMessage>(
  props: {
    model: typeof Model.Type;
    label: string;
    placeholder: string;
    emptyMessage: string;
    items: readonly Item[];
    selectedValues: readonly string[];
    toParentMessage: (message: typeof Message.Type) => ParentMessage;
  },
  h: HtmlBuilder<ParentMessage>,
) => {
  const { model, items, selectedValues, toParentMessage } = props;
  const active = Option.getOrUndefined(model.maybeActiveItemIndex);
  const listId = `${model.id}-items`;
  const itemId = (index: number) => `${model.id}-item-${index}`;
  const select = ({ id, name }: Item) =>
    toParentMessage(
      Message.SelectedItem({
        item: id,
        displayText: name,
        wasSelected: selectedValues.includes(id),
      }),
    );

  return h.div(
    [h.DataAttribute("slot", "multi-combobox")],
    [
      h.input([
        h.Id(Combobox.inputId(model.id)),
        h.DataAttribute("slot", "input"),
        h.Class(inputClassName),
        h.Role("combobox"),
        h.AriaLabel(props.label),
        h.AriaExpanded(true),
        h.AriaControls(listId),
        h.AriaAutocomplete("list"),
        ...(active !== undefined && items[active]
          ? [h.AriaActiveDescendant(itemId(active))]
          : []),
        h.Autocomplete("off"),
        h.Placeholder(props.placeholder),
        h.Value(model.inputValue),
        h.OnInput((value) =>
          toParentMessage(Message.UpdatedInputValue({ value })),
        ),
        h.OnKeyDownPreventDefault((key) => {
          const item = items[active ?? 0];
          if (key === "Enter" && item) return Option.some(select(item));
          if (!items.length || (key !== "ArrowDown" && key !== "ArrowUp"))
            return Option.none();
          const next =
            key === "ArrowDown"
              ? (active ?? -1) + 1
              : (active ?? items.length) - 1;
          return Option.some(
            toParentMessage(
              Message.ActivatedItem({
                index: Math.max(0, Math.min(next, items.length - 1)),
                activationTrigger: "Keyboard",
                maybeImmediateSelection: Option.none(),
              }),
            ),
          );
        }),
      ]),
      h.div(
        [
          h.Id(listId),
          h.Role("listbox"),
          h.AriaLabel(props.label),
          h.AriaMultiSelectable(true),
          h.Class(stylex.props(styles.list).className ?? ""),
          h.OnMount(
            mapMessage(Combobox.AttachComboboxPreventBlur(), toParentMessage),
          ),
        ],
        items.map((item, index) => {
          const selected = selectedValues.includes(item.id);
          return h.div(
            [
              h.Key(item.id),
              h.Id(itemId(index)),
              h.Role("option"),
              h.AriaSelected(selected),
              ...(index === active ? [h.DataAttribute("active", "")] : []),
              h.Class(stylex.props(styles.option).className ?? ""),
              h.OnClick(select(item)),
            ],
            [
              h.span(
                [h.AriaHidden(true)],
                selected ? [outlineIcon(h, ["m5 12 4 4L19 6"])] : [],
              ),
              h.span([], [item.name]),
            ],
          );
        }),
      ),
      ...(items.length
        ? []
        : [
            h.div(
              [
                h.Role("status"),
                h.Class(stylex.props(styles.empty).className ?? ""),
              ],
              [props.emptyMessage],
            ),
          ]),
    ],
  );
};
