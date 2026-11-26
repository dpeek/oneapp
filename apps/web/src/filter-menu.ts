import { badge, outlineIcon, Popover } from "@orumai/ui";
import { Effect, Option, Queue, Schema, Stream } from "effect";
import { Mount } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { mapMessage } from "foldkit/mount";

const FilterMenuMessage = defineMessageUnion({
  OpenedFilterCategory: {
    category: Schema.String,
    focusOptions: Schema.Boolean,
  },
  ClosedFilterCategory: {},
});

export const filterChoice = <Message>(
  props: {
    key?: string;
    label: string;
    checked: boolean;
    message: Message;
    radioGroup?: string;
  },
  h: HtmlBuilder<Message>,
) =>
  h.label(
    [h.Key(props.key ?? props.label), h.Class("filter-menu-choice")],
    [
      h.input([
        ...(props.radioGroup
          ? [h.Type("radio"), h.Name(props.radioGroup)]
          : [h.Type("checkbox")]),
        h.Checked(props.checked),
        h.OnChange(() => props.message),
      ]),
      props.label,
    ],
  );

const WatchFilterMenu = Mount.defineStream("WatchFilterMenu", {
  args: { optionsId: Schema.String },
  messages: [
    FilterMenuMessage.OpenedFilterCategory,
    FilterMenuMessage.ClosedFilterCategory,
  ],
  execute: ({ element, optionsId }) =>
    Stream.callback<
      | typeof FilterMenuMessage.OpenedFilterCategory.Type
      | typeof FilterMenuMessage.ClosedFilterCategory.Type
    >((queue) => {
      const submenuSelector = `#${optionsId}`;
      const close = FilterMenuMessage.ClosedFilterCategory();
      const hover = (event: Event) => {
        if (
          !(event instanceof PointerEvent) ||
          event.pointerType === "touch" ||
          !(event.target instanceof Element)
        )
          return;
        const item =
          event.target.closest<HTMLButtonElement>('[role="menuitem"]');
        if (
          !item ||
          item.getAttribute("aria-expanded") === "true" ||
          (event.relatedTarget instanceof Node &&
            item.contains(event.relatedTarget))
        )
          return;
        const category = item.getAttribute("data-filter-category");
        if (document.activeElement?.closest(submenuSelector))
          item.focus({ preventScroll: true });
        Queue.offerUnsafe(
          queue,
          category !== null
            ? FilterMenuMessage.OpenedFilterCategory({
                category,
                focusOptions: false,
              })
            : close,
        );
      };
      const keydown = (event: Event) => {
        if (
          !(event instanceof KeyboardEvent) ||
          event.isComposing ||
          !(event.target instanceof Element)
        )
          return;
        const submenu = event.target.closest(submenuSelector);
        if (submenu && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          const parent = submenu.previousElementSibling;
          if (parent instanceof HTMLElement)
            parent.focus({ preventScroll: true });
          Queue.offerUnsafe(queue, close);
        }
        if (
          !event.target.matches('[role="menuitem"]') ||
          (event.key !== "ArrowDown" &&
            event.key !== "ArrowUp" &&
            event.key !== "Home" &&
            event.key !== "End")
        )
          return;
        const items = Array.from(
          element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
        );
        const index = items.findIndex((item) => item === event.target);
        const next = {
          ArrowDown: (index + 1) % items.length,
          ArrowUp: (index + items.length - 1) % items.length,
          Home: 0,
          End: items.length - 1,
        }[event.key];
        const target = items[next];
        if (target) {
          event.preventDefault();
          target.focus({ preventScroll: true });
        }
      };
      return Effect.acquireRelease(
        Effect.sync(() => {
          element.addEventListener("pointerover", hover);
          element.addEventListener("keydown", keydown);
        }),
        () =>
          Effect.sync(() => {
            element.removeEventListener("pointerover", hover);
            element.removeEventListener("keydown", keydown);
          }),
      );
    }),
});

export const filterMenu = <Message, Category extends string>(
  props: {
    popover: typeof Popover.Model.Type;
    category: Category | null;
    categories: readonly { id: Category; label: string }[];
    count: number;
    optionsId: string;
    options: (category: Category) => readonly Html[];
    onOpen: (category: Category, focusOptions: boolean) => Message;
    close: Message;
    clear: Message;
    toPopoverMessage: (message: typeof Popover.Message.Type) => Message;
  },
  h: HtmlBuilder<Message>,
) => {
  const { count, optionsId } = props;
  const onNavigation = (message: typeof FilterMenuMessage.Type) => {
    if (message._tag === "OpenedFilterCategory") {
      const category = props.categories.find(
        ({ id }) => id === message.category,
      );
      if (category) return props.onOpen(category.id, message.focusOptions);
    }
    return props.close;
  };
  return Popover.view(
    {
      model: props.popover,
      label: "Filters",
      triggerLabel: count ? `Filters, ${count} selected` : "Filters",
      trigger: h.span(
        [h.Class("filter-menu-trigger")],
        [
          outlineIcon(h, ["M4 7h16M7 12h10m-7 5h4"]),
          ...(count ? [badge(String(count), h)] : []),
        ],
      ),
      placement: "bottom-start",
      portal: false,
      panelClassName: "filter-menu-popover",
      focusSelector: ".filter-menu-categories [data-filter-category]",
      content: h.div(
        [
          h.Class("filter-menu-categories"),
          h.Role("menu"),
          h.AriaLabel("Filter types"),
          h.OnMount(mapMessage(WatchFilterMenu({ optionsId }), onNavigation)),
        ],
        [
          ...props.categories.map(({ id: category, label }) => {
            const expanded = props.category === category;
            const enter = props.onOpen(category, true);
            return h.div(
              [h.Key(category), h.Class("filter-menu-item"), h.Role("none")],
              [
                h.button(
                  [
                    h.Type("button"),
                    h.Class("filter-menu-menuitem"),
                    h.DataAttribute("slot", "filter-menu-menuitem"),
                    h.DataAttribute("filter-category", category),
                    h.Role("menuitem"),
                    h.AriaExpanded(expanded),
                    ...(expanded ? [h.AriaControls(optionsId)] : []),
                    h.OnClick(enter),
                    h.OnKeyDownPreventDefault((key) =>
                      key === "ArrowRight" || key === "ArrowLeft"
                        ? Option.some(enter)
                        : Option.none(),
                    ),
                  ],
                  [label, outlineIcon(h, ["m9 18 6-6-6-6"])],
                ),
                ...(expanded
                  ? [
                      h.div(
                        [
                          h.Key(category),
                          h.Id(optionsId),
                          h.Class("filter-menu-options"),
                          h.Role("group"),
                          h.AriaLabel(`${label} filters`),
                        ],
                        props.options(category),
                      ),
                    ]
                  : []),
              ],
            );
          }),
          h.button(
            [
              h.Type("button"),
              h.Class("filter-menu-menuitem"),
              h.DataAttribute("slot", "filter-menu-menuitem"),
              h.Role("menuitem"),
              h.OnClick(props.clear),
            ],
            ["Clear filters"],
          ),
        ],
      ),
      toParentMessage: props.toPopoverMessage,
    },
    h,
  );
};
