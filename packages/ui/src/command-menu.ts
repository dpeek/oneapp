// Adapted from CreaseUI's StyleX Command (MIT), revision b11a974af28917ae6fea67cbf9ade89d8a3c464c.
import { Combobox } from "@foldkit/ui";
import * as stylex from "@stylexjs/stylex";
import { Option } from "effect";
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html";
import { outlineIcon } from "./icons.ts";
import { controls } from "./tokens.stylex.ts";

export const { Model, Message, init } = Combobox;
type Model = typeof Model.Type;
type Message = typeof Message.Type;

const styles = stylex.create({
  search: {
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
    paddingInline: "1rem",
    borderBlockEndWidth: 1,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: `color-mix(in srgb, ${controls.border} 65%, transparent)`,
    color: {
      default: controls.mutedForeground,
      ":has(input:focus-visible)": controls.focus,
    },
  },
  icon: { display: "flex", flexShrink: 0 },
  input: {
    flex: 1,
    minInlineSize: 0,
    padding: "0.875rem 0",
    borderStyle: "none",
    backgroundColor: "transparent",
    color: controls.foreground,
    fontFamily: "inherit",
    fontSize: "1rem",
    lineHeight: 1.5,
    outlineStyle: "none",
    "::placeholder": { color: controls.mutedForeground },
  },
  list: { padding: { ":not(:empty)": "0.375rem 0.5rem" } },
  item: {
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
    padding: "0.5rem",
    borderRadius: controls.radius,
    backgroundColor: { ":is([data-active])": controls.hover },
    cursor: "pointer",
  },
  empty: {
    padding: "0.75rem",
    color: controls.mutedForeground,
    textAlign: "center",
  },
});

const matches = (query: string, label: string) => {
  const text = label.toLowerCase();
  let index = 0;
  for (const letter of query.trim().toLowerCase()) {
    index = text.indexOf(letter, index);
    if (index === -1) return false;
    index++;
  }
  return true;
};

type Item<Value extends string> = Readonly<{
  value: Value;
  label: string;
  iconPaths?: ReadonlyArray<string>;
}>;

// Crease's inline combobox keeps the list visible and highlights the first match.
export const create = <Value extends string>() => {
  const { update } = Combobox.create<Value>();
  return {
    update,
    view: <ParentMessage>(
      {
        model,
        items,
        searchLabel = "Search commands",
        initialFocus,
        toParentMessage,
      }: {
        model: Model;
        items: readonly Item<Value>[];
        searchLabel?: string;
        initialFocus: ReadonlyArray<ChildAttribute>;
        toParentMessage: (message: Message) => ParentMessage;
      },
      h: HtmlBuilder<ParentMessage>,
    ): Html => {
      const visible = items.filter(({ label }) =>
        matches(model.inputValue, label),
      );
      const active = Option.getOrUndefined(model.maybeActiveItemIndex) ?? 0;
      const index = visible[active] ? active : 0;
      const item = visible[index];
      const listId = `${model.id}-items`;
      const itemId = (position: number) => `${model.id}-item-${position}`;
      const select = ({ value, label }: Item<Value>) =>
        toParentMessage(
          Message.SelectedItem({
            item: value,
            displayText: label,
            wasSelected: false,
          }),
        );
      return h.div(
        [h.DataAttribute("slot", "command")],
        [
          h.div(
            [
              h.DataAttribute("slot", "command-header"),
              h.Class(stylex.props(styles.search).className ?? ""),
            ],
            [
              h.span(
                [h.Class(stylex.props(styles.icon).className ?? "")],
                [
                  outlineIcon(h, [
                    "M21 21l-4.35-4.35",
                    "M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
                  ]),
                ],
              ),
              h.input([
                h.Id(Combobox.inputId(model.id)),
                h.DataAttribute("slot", "command-input"),
                h.Class(stylex.props(styles.input).className ?? ""),
                h.Role("combobox"),
                h.AriaLabel(searchLabel),
                h.AriaExpanded(true),
                h.AriaControls(listId),
                h.AriaAutocomplete("list"),
                ...(item ? [h.AriaActiveDescendant(itemId(index))] : []),
                ...initialFocus,
                h.Autocomplete("off"),
                h.Placeholder(searchLabel),
                h.Value(model.inputValue),
                h.OnInput((value) =>
                  toParentMessage(Message.UpdatedInputValue({ value })),
                ),
                h.OnKeyDownPreventDefault((key) => {
                  if (key === "Enter" && item) return Option.some(select(item));
                  const next = Math.min(
                    visible.length - 1,
                    key === "ArrowDown" ? index + 1 : index - 1,
                  );
                  return visible.length > 0 &&
                    (key === "ArrowDown" || key === "ArrowUp")
                    ? Option.some(
                        toParentMessage(
                          Message.ActivatedItem({
                            index: Math.max(0, next),
                            activationTrigger: "Keyboard",
                            maybeImmediateSelection: Option.none(),
                          }),
                        ),
                      )
                    : Option.none();
                }),
              ]),
            ],
          ),
          h.div(
            [
              h.Id(listId),
              h.Role("listbox"),
              h.AriaLabel("Commands"),
              h.Class(stylex.props(styles.list).className ?? ""),
            ],
            visible.map((option, position) =>
              h.div(
                [
                  h.Key(option.value),
                  h.Id(itemId(position)),
                  h.Role("option"),
                  h.AriaSelected(position === index),
                  h.DataAttribute("slot", "command-item"),
                  ...(position === index
                    ? [h.DataAttribute("active", "")]
                    : []),
                  h.Class(stylex.props(styles.item).className ?? ""),
                  h.OnClick(select(option)),
                ],
                [
                  ...(option.iconPaths
                    ? [
                        h.span(
                          [h.Class(stylex.props(styles.icon).className ?? "")],
                          [outlineIcon(h, option.iconPaths)],
                        ),
                      ]
                    : []),
                  option.label,
                ],
              ),
            ),
          ),
          ...(item
            ? []
            : [
                h.div(
                  [
                    h.Role("status"),
                    h.Class(stylex.props(styles.empty).className ?? ""),
                  ],
                  ["No commands found."],
                ),
              ]),
        ],
      );
    },
  };
};
