import { DropdownMenu, outlineIcon } from "@oneapp/ui";
import { Effect, Option, Schema } from "effect";
import { Command, Port, Runtime, Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { vaultFolderPaths } from "./vault-item-icon.ts";

const Model = DropdownMenu.Model;
type Model = typeof Model.Type;
const Message = defineMessageUnion({
  Menu: { message: DropdownMenu.Message },
  Completed: {},
});
type Message = typeof Message.Type;
const toMenu = (message: typeof DropdownMenu.Message.Type) =>
  Message.Menu({ message });
const ports = {
  outbound: { move: Port.outbound(Schema.String) },
};
const Move = Command.define("MoveVaultSelection", {
  args: { folderId: Schema.String },
  messages: [Message.Completed],
  execute: ({ folderId }) =>
    Port.emit(ports.outbound.move, folderId).pipe(
      Effect.as(Message.Completed()),
    ),
});
const menu = DropdownMenu.create<string>();
const updateMenu = Update.foldChild({
  update: menu.update,
  read: (model: Model) => Option.some(model),
  write: (_model, menu) => menu,
  toParentMessage: toMenu,
  foldOutMessage:
    ({ value }) =>
    (model) => ({ model, commands: [Move({ folderId: value })] }),
});
const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match(message, {
    Menu: ({ message }) => updateMenu(model, message),
    Completed: () => ({ model }),
  });

export const mountVaultMoveMenu = (
  container: HTMLElement,
  folders: readonly { folder: { id: string }; title: string }[],
  onMove: (folderId: string | null) => void,
) => {
  container.id = "vault-move-menu-mount";
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container,
      ports,
      init: () => ({ model: DropdownMenu.init({ id: "vault-move-menu" }) }),
      update,
      view: (model, h) =>
        menu.view(
          {
            model,
            label: "Move…",
            trigger: h.span([], ["Move…"]),
            triggerVariant: "ghost",
            placement: "top-start",
            toParentMessage: toMenu,
            items: [
              {
                action: "",
                label: "No folder",
                icon: outlineIcon(h, ["M5 12h14"]),
              },
              ...folders.map(({ folder, title }) => ({
                action: folder.id,
                label: title,
                icon: outlineIcon(h, vaultFolderPaths),
              })),
            ],
          },
          h,
        ),
    }),
  );
  handle.ports.move.subscribe((folderId) => onMove(folderId || null));
  return () => handle.dispose();
};
