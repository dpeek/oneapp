import { Combobox } from "@foldkit/ui";
import * as stylex from "@stylexjs/stylex";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { mapMessage } from "foldkit/mount";
import { inputClassName } from "./field.ts";
import { outlineIcon } from "./icons.ts";
import { controls } from "./tokens.stylex.ts";

export const { Message, inputId } = Combobox;
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
  single: { gridTemplateColumns: "minmax(0, 1fr) 1rem" },
  label: { display: "flex", alignItems: "center", gap: "0.5rem" },
  disabled: { opacity: 0.55, cursor: "default" },
  empty: { padding: "0.5rem", color: controls.mutedForeground },
});

type Item = Readonly<{
  id: string;
  name: string;
  disabled?: boolean;
  content?: Html;
}>;

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
    single?: boolean;
    searchable?: boolean;
    toParentMessage: (message: typeof Message.Type) => ParentMessage;
  },
  h: HtmlBuilder<ParentMessage>,
) => {
  const { model, items, selectedValues, toParentMessage } = props;
  const { single = false, searchable = true } = props;
  const listId = `${model.id}-items`;
  const itemId = (index: number) => `${model.id}-item-${index}`;
  const enabled = items.flatMap((item, index) =>
    item.disabled ? [] : [index],
  );
  const requested = Option.getOrUndefined(model.maybeActiveItemIndex);
  const active =
    requested !== undefined && enabled.includes(requested)
      ? requested
      : single
        ? enabled[0]
        : undefined;
  const select = ({ id, name }: Item) =>
    toParentMessage(
      Message.SelectedItem({
        item: id,
        displayText: name,
        wasSelected: selectedValues.includes(id),
      }),
    );
  const keydown = h.OnKeyDownPreventDefault((key) => {
    const item = items[active ?? enabled[0] ?? -1];
    if ((key === "Enter" || (!searchable && key === " ")) && item)
      return Option.some(select(item));
    if (!enabled.length || (key !== "ArrowDown" && key !== "ArrowUp"))
      return Option.none();
    const position =
      active === undefined
        ? key === "ArrowDown"
          ? -1
          : enabled.length
        : enabled.indexOf(active);
    const next = position + (key === "ArrowDown" ? 1 : -1);
    return Option.some(
      toParentMessage(
        Message.ActivatedItem({
          index: enabled[Math.max(0, Math.min(next, enabled.length - 1))]!,
          activationTrigger: "Keyboard",
          maybeImmediateSelection: Option.none(),
        }),
      ),
    );
  });
  const activeDescendant =
    active !== undefined ? [h.AriaActiveDescendant(itemId(active))] : [];
  return h.div(
    [h.DataAttribute("slot", "multi-combobox")],
    [
      ...(searchable
        ? [
            h.input([
              h.Id(inputId(model.id)),
              h.DataAttribute("slot", "input"),
              h.Class(inputClassName),
              h.Role("combobox"),
              h.AriaLabel(props.label),
              h.AriaExpanded(true),
              h.AriaControls(listId),
              h.AriaAutocomplete("list"),
              ...activeDescendant,
              h.Autocomplete("off"),
              h.Placeholder(props.placeholder),
              h.Value(model.inputValue),
              h.OnInput((value) =>
                toParentMessage(Message.UpdatedInputValue({ value })),
              ),
              keydown,
            ]),
          ]
        : []),
      h.div(
        [
          h.Id(listId),
          h.Role("listbox"),
          h.AriaLabel(props.label),
          ...(!single ? [h.AriaMultiSelectable(true)] : []),
          ...(!searchable ? [h.Tabindex(0), ...activeDescendant, keydown] : []),
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
              h.Class(
                stylex.props(
                  styles.option,
                  single && styles.single,
                  item.disabled && styles.disabled,
                ).className ?? "",
              ),
              ...(item.disabled
                ? [h.AriaDisabled(true)]
                : [h.OnClick(select(item))]),
            ],
            [
              ...(single
                ? [
                    h.span(
                      [h.Class(stylex.props(styles.label).className ?? "")],
                      [item.content ?? item.name],
                    ),
                  ]
                : []),
              h.span(
                [h.AriaHidden(true)],
                selected ? [outlineIcon(h, ["m5 12 4 4L19 6"])] : [],
              ),
              ...(!single ? [h.span([], [item.content ?? item.name])] : []),
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
