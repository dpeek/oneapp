import {
  avatar,
  ItemActionMenu,
  itemClassName,
  itemClassNames,
  outlineIcon,
  trashIconPaths,
} from "@orumai/ui";
import { Effect, Schema } from "effect";
import { Command, Mount, Port, Runtime, Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { itemTypes, type ItemType } from "./vault-item-content.ts";
import { vaultFolderPaths, vaultItemPaths } from "./vault-item-icon.ts";

const actionsId = "vault-item-actions";
const initial = ItemActionMenu.init(actionsId);
const actions = {
  edit: { label: "Edit", paths: ["m4 16 12-12 4 4L8 20H4v-4Zm10-10 4 4"] },
  move: { label: "Move…", paths: vaultFolderPaths },
  archive: { label: "Archive", paths: ["M4 8h16v11H4zM3 4h18v4H3zM10 12h4"] },
  unarchive: {
    label: "Unarchive",
    paths: ["M4 12v8h16v-8M12 15V4M8 8l4-4 4 4"],
  },
  trash: { label: "Move to Trash", paths: trashIconPaths, destructive: true },
  restore: { label: "Restore", paths: ["M4 11a8 8 0 1 1 2 7M4 5v6h6"] },
  purge: {
    label: "Permanently delete",
    paths: trashIconPaths,
    destructive: true,
  },
};
type RowAction = keyof typeof actions;
type Row = {
  id: string;
  title: string;
  type: ItemType;
  icon: string | null;
  actions: readonly RowAction[];
};

export const vaultRowActions = (
  view: "active" | "archive" | "trash",
  readable: boolean,
): readonly RowAction[] =>
  view === "trash"
    ? ["restore", "purge"]
    : [
        ...(readable ? ["edit" as const] : []),
        "move",
        view === "active" ? "archive" : "unarchive",
        "trash",
      ];

const RowEvent = Schema.Struct({
  key: Schema.String,
  action: Schema.Literals([
    "open",
    "selection",
    "edit",
    "move",
    "archive",
    "unarchive",
    "trash",
    "restore",
    "purge",
  ]),
});
const Message = defineMessageUnion({
  Row: { event: RowEvent },
  Menu: { message: ItemActionMenu.Message },
  Completed: {},
});
type Message = typeof Message.Type;
const ports = { outbound: { row: Port.outbound(RowEvent) } };
const notify = Command.define("HandleVaultItemListEvent", {
  args: RowEvent.fields,
  messages: [Message.Completed],
  execute: (event) =>
    Port.emit(ports.outbound.row, event).pipe(Effect.as(Message.Completed())),
});
const menu = ItemActionMenu.create<RowAction>();
const toMenu = (message: ItemActionMenu.Message) => Message.Menu({ message });
const update = (
  model: ItemActionMenu.Model,
  message: Message,
): Update.Return<ItemActionMenu.Model, Message> =>
  Message.match(message, {
    Completed: () => ({ model }),
    Row: ({ event }) => ({ model, commands: [notify(event)] }),
    Menu: ({ message }) => {
      const { model: next, commands, outMessage } = menu.update(model, message);
      return {
        model: next,
        commands: [
          ...Command.mapMessages(commands, toMenu),
          ...(outMessage ? [notify(outMessage)] : []),
        ],
      };
    },
  });

export const vaultRowCheckboxId = (key: string) => `vault-select-${key}`;
export const vaultRowFocus = (key: string) => {
  const trigger = document.getElementById(
    ItemActionMenu.triggerId(actionsId, key),
  );
  return trigger?.getClientRects().length
    ? trigger
    : document.getElementById(ItemActionMenu.rowLinkId(actionsId, key));
};

const rowView = (
  row: Row,
  model: ItemActionMenu.Model,
  checked: boolean,
  h: HtmlBuilder<Message>,
) => {
  const { id: key, title, type } = row;
  const items = row.actions.map((action) => {
    const { paths, ...item } = actions[action];
    return { action, ...item, disabled: false, icon: outlineIcon(h, paths) };
  });
  return h.li(
    [
      h.Key(key),
      h.DataAttribute("slot", "item"),
      h.DataAttribute("variant", "default"),
      h.Class(itemClassName()),
      ...ItemActionMenu.rowAttributes(key, toMenu, h),
    ],
    [
      h.span(
        [
          h.DataAttribute("slot", "item-actions"),
          h.Class(itemClassNames.actions),
        ],
        [
          h.input([
            h.Type("checkbox"),
            h.Id(vaultRowCheckboxId(key)),
            h.Checked(checked),
            h.AriaLabel(`Select ${title}`),
            h.OnChange(() =>
              Message.Row({ event: { key, action: "selection" } }),
            ),
          ]),
        ],
      ),
      h.button(
        [
          h.Type("button"),
          h.Value(key),
          h.DataAttribute("slot", "item-link"),
          h.Class(`vault-row ${itemClassNames.button}`),
          h.OnClick(Message.Row({ event: { key, action: "open" } })),
          ...ItemActionMenu.rowLinkAttributes(actionsId, key, items, toMenu, h),
        ],
        [
          h.span(
            [
              h.DataAttribute("slot", "item-media"),
              h.Class(`vault-item-icon ${itemClassNames.media}`),
            ],
            [
              avatar(
                {
                  variant: "square",
                  src: row.icon,
                  fallback: outlineIcon(h, vaultItemPaths[type]),
                  imageMounted: Message.Completed(),
                },
                h,
              ),
            ],
          ),
          h.span(
            [
              h.DataAttribute("slot", "item-content"),
              h.Class(itemClassNames.content),
            ],
            [
              h.span(
                [
                  h.DataAttribute("slot", "item-title"),
                  h.Class(itemClassNames.title),
                ],
                [title],
              ),
              h.span(
                [
                  h.DataAttribute("slot", "item-description"),
                  h.Class(itemClassNames.description),
                ],
                [itemTypes[type].label],
              ),
            ],
          ),
        ],
      ),
      h.div(
        [
          h.DataAttribute("slot", "item-actions"),
          h.Class(`vault-row-menu ${itemClassNames.actions}`),
        ],
        [
          menu.view(
            {
              model,
              rowKey: key,
              label: `Actions for ${title}`,
              items,
              toParentMessage: toMenu,
            },
            h,
          ),
        ],
      ),
    ],
  );
};

export const mountVaultItemList = (
  container: HTMLElement,
  rows: readonly Row[],
  selected: ReadonlySet<string>,
  onRowEvent: (event: typeof RowEvent.Type) => void,
  onReady: () => void,
) => {
  // Scope Foldkit's development reload state to this mount.
  container.id = `vault-item-list-${crypto.randomUUID()}`;
  const Ready = Mount.define("VaultItemListReady", {
    messages: [Message.Completed],
    execute: () =>
      Effect.sync(() => {
        onReady();
        return Message.Completed();
      }),
  });
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model: ItemActionMenu.Model,
      container,
      ports,
      init: () => ({ model: initial }),
      update,
      // Vault records and the encryption key stay in the reader.
      view: (model, h) =>
        h.ul(
          [
            h.Class(`vault-items ${itemClassNames.group}`),
            h.DataAttribute("slot", "item-group"),
            h.Role("list"),
            h.OnMount(Ready()),
          ],
          rows.map((row) => rowView(row, model, selected.has(row.id), h)),
        ),
    }),
  );
  handle.ports.row.subscribe(onRowEvent);
  return handle.dispose;
};
