import {
  backIcon,
  button,
  DropdownMenu,
  outlineIcon,
  plusIcon,
  Sheet,
} from "@orumai/ui";
import { Effect, Option, Schema } from "effect";
import { Command, Port, Runtime, Subscription, Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
import {
  ItemType,
  itemTypes,
  vaultItemTypeOrder,
} from "./vault-item-content.ts";
import { vaultItemPaths } from "./vault-item-icon.ts";
import { screenHeader, workspaceDrawerMedia } from "./workspace.ts";

const HeaderState = Schema.Struct({
  title: Schema.String,
  showNew: Schema.Boolean,
  showFilters: Schema.Boolean,
  showBack: Schema.Boolean,
  busy: Schema.Boolean,
});
type HeaderState = typeof HeaderState.Type;
const Model = Schema.Struct({
  state: HeaderState,
  menu: DropdownMenu.Model,
  filters: Sheet.Model,
});
type Model = typeof Model.Type;
const Message = defineMessageUnion({
  Changed: { state: HeaderState },
  Menu: { message: DropdownMenu.Message },
  Filters: { message: Sheet.Message },
  Back: {},
  Completed: {},
});
type Message = typeof Message.Type;

const ports = {
  inbound: {
    header: Port.inbound(HeaderState),
    closeFilters: Port.inbound(Schema.Null),
  },
  outbound: {
    newItem: Port.outbound(ItemType),
    back: Port.outbound(Schema.Null),
  },
};
const toMenu = (message: typeof DropdownMenu.Message.Type) =>
  Message.Menu({ message });
const toFilters = (message: typeof Sheet.Message.Type) =>
  Message.Filters({ message });
const subscriptions = Subscription.make<Model, Message>()(() => ({
  header: Port.subscriptionEntry(ports.inbound.header, (state) =>
    Message.Changed({ state }),
  ),
  closeFilters: Port.subscriptionEntry(ports.inbound.closeFilters, () =>
    toFilters(Sheet.Message.RequestedClose()),
  ),
}));

const StartItem = Command.define("StartVaultItem", {
  args: { type: ItemType },
  messages: [Message.Completed],
  execute: ({ type }) =>
    Port.emit(ports.outbound.newItem, type).pipe(
      Effect.as(Message.Completed()),
    ),
});
const Back = Command.define("VaultPanelBack", {
  args: {},
  messages: [Message.Completed],
  execute: () =>
    Port.emit(ports.outbound.back, null).pipe(Effect.as(Message.Completed())),
});
const newItemMenu = DropdownMenu.create<`${ItemType}`>();
const foldMenu = Update.foldChild({
  update: newItemMenu.update,
  read: (model: Model) => Option.some(model.menu),
  write: (model, menu) => ({ ...model, menu }),
  toParentMessage: toMenu,
  foldOutMessage:
    ({ value }) =>
    (model) => {
      const type = vaultItemTypeOrder.find((type) => String(type) === value);
      return type && model.state.showNew && !model.state.busy
        ? { model, commands: [StartItem({ type })] }
        : { model };
    },
});
const foldFilters = Update.foldChild({
  update: Sheet.update,
  read: (model: Model) => Option.some(model.filters),
  write: (model, filters) => ({ ...model, filters }),
  toParentMessage: toFilters,
  foldOutMessage: () => (model) => ({ model }),
});
const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match(message, {
    Changed: ({ state }) => ({ model: { ...model, state } }),
    Menu: ({ message }) => foldMenu(model, message),
    Filters: ({ message }) => foldFilters(model, message),
    Back: () => ({ model, commands: [Back({})] }),
    Completed: () => ({ model }),
  });

export const mountVaultWorkspaceHeader = (
  container: HTMLElement,
  sidebar: HTMLElement,
  navigation: HTMLElement,
  handlers: { newItem: (type: ItemType) => void; back: () => void },
) => {
  // Only navigation state and item type constants cross into Foldkit.
  const MountFilters = Mount.define("MountVaultFilters", {
    messages: [Message.Completed],
    execute: ({ element }) =>
      Effect.acquireRelease(
        Effect.sync(() => element.append(navigation)),
        () => Effect.sync(() => sidebar.append(navigation)),
      ).pipe(Effect.as(Message.Completed())),
  });
  const view = ({ state, menu, filters }: Model, h: HtmlBuilder<Message>) =>
    h.div(
      [h.Class("vault-header-mount")],
      [
        screenHeader(
          {
            title: state.title,
            navigation: [
              ...(state.showBack
                ? [
                    button(
                      {
                        variant: "ghost",
                        size: "icon-sm",
                        rounded: true,
                        ariaLabel: "Back",
                        disabled: state.busy,
                        onClick: Message.Back(),
                        children: [backIcon(h)],
                      },
                      h,
                    ),
                  ]
                : []),
              ...(state.showFilters
                ? [
                    h.div(
                      [h.Class("workspace-drawer-trigger")],
                      [
                        button(
                          {
                            variant: "ghost",
                            size: "icon-sm",
                            rounded: true,
                            ariaLabel: "Filters",
                            dialogId: filters.id,
                            disabled: state.busy,
                            onClick: toFilters(Sheet.Message.RequestedOpen()),
                            children: [
                              outlineIcon(h, ["M4 7h16M7 12h10m-7 5h4"]),
                            ],
                          },
                          h,
                        ),
                      ],
                    ),
                  ]
                : []),
            ],
            primaryAction: state.showNew
              ? newItemMenu.view(
                  {
                    model: menu,
                    label: "Add item",
                    triggerVariant: "primary",
                    placement: "bottom-end",
                    trigger: h.span(
                      [h.Class("vault-new-label")],
                      [plusIcon(h, "16"), "Item"],
                    ),
                    disabled: state.busy,
                    toParentMessage: toMenu,
                    items: vaultItemTypeOrder.map((type) => ({
                      action: `${type}` as const,
                      label: itemTypes[type].label,
                      icon: outlineIcon(h, vaultItemPaths[type]),
                    })),
                  },
                  h,
                )
              : undefined,
          },
          h,
        ),
        Sheet.sheet(
          {
            model: filters,
            title: "Vault filters",
            content: h.div([h.OnMount(MountFilters())], []),
            toParentMessage: toFilters,
          },
          h,
        ),
      ],
    );
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container,
      ports,
      subscriptions,
      init: () => ({
        model: {
          state: {
            title: "Vault",
            showNew: false,
            showFilters: false,
            showBack: false,
            busy: false,
          },
          menu: DropdownMenu.init({ id: "vault-new-item" }),
          filters: Sheet.init({ id: "vault-filters" }),
        },
      }),
      view,
      update,
    }),
  );
  handle.ports.newItem.subscribe(handlers.newItem);
  handle.ports.back.subscribe(handlers.back);
  const media = matchMedia(workspaceDrawerMedia);
  const closeFilters = () => handle.ports.closeFilters.send(null);
  const updateViewport = (event: MediaQueryListEvent) => {
    if (!event.matches) closeFilters();
  };
  media.addEventListener("change", updateViewport);
  return {
    update: (state: HeaderState) => handle.ports.header.send(state),
    closeFilters,
    dispose: () => {
      media.removeEventListener("change", updateViewport);
      handle.dispose();
    },
  };
};
