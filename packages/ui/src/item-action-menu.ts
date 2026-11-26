import { Menu } from "@foldkit/ui";
import { anchorSetup } from "@foldkit/ui/anchor";
import * as stylex from "@stylexjs/stylex";
import { Effect, Option, Schema } from "effect";
import { Dom, Mount } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { mapMessage } from "foldkit/mount";
import * as DropdownMenu from "./dropdown-menu.ts";
import { ellipsisIcon } from "./icons.ts";
import {
  createUpdate,
  initRow,
  Message,
  type Model,
  rowLinkId,
} from "./item-action-menu-state.ts";

export {
  init,
  Message,
  Model,
  rowLinkId,
  triggerId,
} from "./item-action-menu-state.ts";

const styles = stylex.create({
  trigger: {
    display: { "@media not (any-pointer: coarse)": "none" },
  },
  item: { minBlockSize: { "@media (pointer: coarse)": "2.75rem" } },
  contextAnchor: {
    position: "fixed",
    inlineSize: 0,
    blockSize: 0,
    pointerEvents: "none",
  },
});

const WatchContext = Mount.defineStream("WatchItemActionContext", {
  args: { key: Schema.String },
  messages: [Message.OpenedContext],
  execute: ({ element, key }) =>
    Dom.streamFromEventFilterMapPreventDefault({
      target: element,
      type: "contextmenu",
      filterMapEvent: (event) =>
        event instanceof MouseEvent && event.button === 2
          ? Option.some(
              Message.OpenedContext({
                key,
                point: { x: event.clientX, y: event.clientY },
              }),
            )
          : Option.none(),
    }),
});

const PositionContextMenu = Mount.define("PositionItemActionContextMenu", {
  args: {
    anchorId: Schema.String,
    originId: Schema.String,
    atPointer: Schema.Boolean,
  },
  messages: [Menu.Message.CompletedAnchorMenu],
  execute: ({ element, anchorId, originId, atPointer }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const root = element.getRootNode();
        const origin =
          root instanceof Document || root instanceof ShadowRoot
            ? root.getElementById(originId)
            : null;
        const cleanupAnchor = anchorSetup(element, {
          buttonId: anchorId,
          anchor: atPointer
            ? { placement: "bottom-start", gap: 2, padding: 4 }
            : { placement: "bottom-end", gap: 4 },
          focusAfterPosition: true,
          interceptTab: false,
        });
        // Continue native Tab navigation from the element that owns the menu.
        const handleTab = (event: Event) => {
          if (event instanceof KeyboardEvent && event.key === "Tab")
            origin?.focus({ preventScroll: true });
        };
        element.addEventListener("keydown", handleTab);
        return () => {
          element.removeEventListener("keydown", handleTab);
          cleanupAnchor();
        };
      }),
      (cleanup) => Effect.sync(cleanup),
    ).pipe(Effect.as(Menu.Message.CompletedAnchorMenu())),
});

export const rowAttributes = <ParentMessage>(
  key: string,
  toParentMessage: (message: Message) => ParentMessage,
  h: HtmlBuilder<ParentMessage>,
) => [h.OnMount(mapMessage(WatchContext({ key }), toParentMessage))];

export const rowLinkAttributes = <ParentMessage>(
  id: string,
  key: string,
  items: readonly Pick<DropdownMenu.Item<string>, "disabled">[],
  toParentMessage: (message: Message) => ParentMessage,
  h: HtmlBuilder<ParentMessage>,
) => [
  h.Id(rowLinkId(id, key)),
  h.OnKeyDownPreventDefault((pressed, { shiftKey }) =>
    pressed === "ContextMenu" || (pressed === "F10" && shiftKey)
      ? Option.some(
          toParentMessage(
            Message.OpenedFromRow({
              key,
              firstEnabledIndex: items.findIndex((item) => !item.disabled),
            }),
          ),
        )
      : Option.none(),
  ),
];

export const create = <Action extends string>() => {
  const menu = DropdownMenu.create<Action>();
  return {
    update: createUpdate<Action>(),
    view: <ParentMessage>(
      props: {
        model: Model;
        rowKey: string;
        label: string;
        items: readonly DropdownMenu.Item<Action>[];
        toParentMessage: (message: Message) => ParentMessage;
      },
      h: HtmlBuilder<ParentMessage>,
    ) => {
      const { model, rowKey, label, items, toParentMessage } = props;
      const row =
        model.row?.key === rowKey ? model.row : initRow(model.id, rowKey);
      const linkId = rowLinkId(model.id, rowKey);
      const pointerId = `${row.menu.id}-pointer`;
      const toMenuMessage = (message: typeof Menu.Message.Type) =>
        toParentMessage(Message.GotMenu({ key: rowKey, message }));
      return h.div(
        [],
        [
          ...(row.point
            ? [
                h.span(
                  [
                    h.Id(pointerId),
                    h.AriaHidden(true),
                    h.Class(stylex.props(styles.contextAnchor).className ?? ""),
                    h.Style({
                      left: `${row.point.x}px`,
                      top: `${row.point.y}px`,
                    }),
                  ],
                  [],
                ),
              ]
            : []),
          menu.view(
            {
              model: row.menu,
              label,
              trigger: ellipsisIcon(h),
              triggerSize: "icon",
              triggerClassName: stylex.props(styles.trigger).className,
              placement: "bottom-end",
              items,
              itemClassName: stylex.props(styles.item).className,
              separateDestructive: true,
              // A last panel OnMount replaces Foldkit's default anchor and Tab handling.
              itemsAttributes:
                row.point || row.returnToRow
                  ? [
                      h.OnMount(
                        mapMessage(
                          PositionContextMenu({
                            anchorId: row.point ? pointerId : linkId,
                            originId: linkId,
                            atPointer: row.point !== null,
                          }),
                          toMenuMessage,
                        ),
                      ),
                    ]
                  : [],
              toParentMessage: toMenuMessage,
            },
            h,
          ),
        ],
      );
    },
  };
};
