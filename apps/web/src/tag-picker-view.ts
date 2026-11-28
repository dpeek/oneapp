import { MultiCombobox, outlineIcon, Popover } from "@orumai/ui";
import type { HtmlBuilder } from "foldkit/html";
import type { Tag } from "./items-contract.ts";
import { clearTagChoice, createTagPrefix, tagChoices } from "./tag-picker.ts";

const tagIcon = ["M20 13.5 13.5 20 4 10.5V4h6.5zM8 8h.01"];
const chevron = ["m7 10 5 5 5-5"];

const tagLabel = <Message>(
  names: readonly string[],
  row: boolean,
  h: HtmlBuilder<Message>,
) => {
  if (!names.length) return "Add tags";
  if (names.length === 1) return names[0]!;
  if (row)
    return h.span(
      [h.Class("task-tag-names")],
      [
        h.span([h.Class("task-tag-name")], [names[0]!]),
        h.span([], [`+${names.length - 1}`]),
      ],
    );
  const summary = `${names.length} tags`;
  return names.length === 2 && names.every((name) => name.length <= 10)
    ? h.span(
        [h.Class("task-detail-tag-pair")],
        [h.span([], [names.join(", ")]), h.span([], [summary])],
      )
    : summary;
};

export const tagProperty = <Message>(
  {
    id,
    picker,
    tags,
    tagIds,
    item,
    row = false,
    disabled,
    creatingDisabled,
    error,
    toPopoverMessage,
    toSearchMessage,
  }: {
    id: string;
    picker: {
      popover: typeof Popover.Model.Type;
      search: typeof MultiCombobox.Model.Type;
    } | null;
    tags: readonly Tag[];
    tagIds: readonly string[];
    item: "task" | "file" | "document";
    row?: boolean;
    disabled?: boolean;
    creatingDisabled: boolean;
    error: string | null;
    toPopoverMessage: (message: typeof Popover.Message.Type) => Message;
    toSearchMessage: (message: typeof MultiCombobox.Message.Type) => Message;
  },
  h: HtmlBuilder<Message>,
) => {
  const names = tags
    .filter(({ id }) => tagIds.includes(id))
    .map(({ name }) => name);
  const label = `Tags: ${names.length ? names.join(", ") : "Add tags"}`;
  const panel = () => {
    if (!picker?.popover.isOpen) return h.empty;
    const result = tagChoices(picker.search.inputValue, tagIds, tags, item);
    const items = result.choices.map((choice) => ({
      ...choice,
      disabled:
        choice.disabled ||
        (creatingDisabled && choice.id.startsWith(createTagPrefix)),
    }));
    if (tagIds.length)
      items.push({
        id: clearTagChoice,
        name: "Clear all tags",
        disabled: false,
      });
    const feedback = error ?? result.error;
    return h.div(
      [],
      [
        MultiCombobox.view(
          {
            model: picker.search,
            items,
            selectedValues: tagIds,
            label: "Search tags",
            placeholder: "Search tags",
            emptyMessage: "No matching tags.",
            toParentMessage: toSearchMessage,
          },
          h,
        ),
        feedback
          ? h.p([h.Role("status"), h.Class("task-picker-feedback")], [feedback])
          : h.empty,
      ],
    );
  };
  return Popover.view(
    {
      model: picker?.popover ?? Popover.init({ id }),
      label: "Tags",
      triggerLabel: label,
      disabled,
      triggerButton: { variant: row ? "quiet" : "ghost", size: "sm" },
      triggerClassName: "task-property-trigger task-property-tagIds",
      triggerAttributes: [h.Title(label)],
      trigger: h.span(
        [h.Class("task-property-content")],
        [
          h.span(
            [
              h.Class("task-row-value"),
              h.DataAttribute("tag-ids", names.length ? "set" : ""),
            ],
            [
              outlineIcon(h, tagIcon),
              h.span(
                [h.Class("task-property-label")],
                [tagLabel(names, row, h)],
              ),
            ],
          ),
          h.span([h.Class("task-property-chevron")], [outlineIcon(h, chevron)]),
        ],
      ),
      placement: "bottom-start",
      portal: true,
      panelClassName: "task-property-panel",
      focusSelector: `#${id}-panel input[role="combobox"]`,
      content: panel(),
      toParentMessage: toPopoverMessage,
    },
    h,
  );
};
