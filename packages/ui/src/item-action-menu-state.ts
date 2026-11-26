import { Menu } from "@foldkit/ui";
import { Effect, Option, Schema } from "effect";
import { Command, Dom, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";

const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number });
export const Model = Schema.Struct({
  id: Schema.String,
  row: Schema.NullOr(
    Schema.Struct({
      key: Schema.String,
      menu: Menu.Model,
      point: Schema.NullOr(Point),
      returnToRow: Schema.Boolean,
    }),
  ),
});
export type Model = typeof Model.Type;
export const init = (id: string): Model => ({ id, row: null });

export const Message = defineMessageUnion({
  OpenedContext: { key: Schema.String, point: Point },
  OpenedFromRow: { key: Schema.String, firstEnabledIndex: Schema.Number },
  GotMenu: { key: Schema.String, message: Menu.Message },
  RestoredRowFocus: {},
});
export type Message = typeof Message.Type;
const menuId = (id: string, key: string) => `${id}-${encodeURIComponent(key)}`;
export const triggerId = (id: string, key: string) =>
  Menu.buttonId(menuId(id, key));
export const rowLinkId = (id: string, key: string) =>
  `${menuId(id, key)}-row-link`;

const RestoreRowFocus = Command.define("RestoreItemActionRowFocus", {
  args: { id: Schema.String },
  messages: [Message.RestoredRowFocus],
  execute: ({ id }) =>
    Dom.focus(`#${CSS.escape(id)}`, { preventScroll: true }).pipe(
      Effect.ignore,
      Effect.as(Message.RestoredRowFocus()),
    ),
});

export const initRow = (id: string, key: string) => ({
  key,
  menu: Menu.init({ id: menuId(id, key) }),
  point: null,
  returnToRow: false,
});

export const createUpdate = <Action extends string>() => {
  const menu = Menu.create<Action>();
  return (
    model: Model,
    message: Message,
  ): Update.ReturnWithOutMessage<
    Model,
    Message,
    { key: string; action: Action }
  > => {
    if (message._tag === "RestoredRowFocus") return { model };
    const { key } = message;
    const row = model.row?.key === key ? model.row : initRow(model.id, key);
    const fromRow = message._tag === "OpenedFromRow";
    const inner =
      message._tag === "GotMenu"
        ? message.message
        : Menu.Message.Opened({
            maybeActiveItemIndex:
              fromRow && message.firstEnabledIndex >= 0
                ? Option.some(message.firstEnabledIndex)
                : Option.none(),
          });
    if (inner._tag === "PressedPointerOnButton" && inner.button !== 0)
      return { model };
    if (
      !row.menu.isOpen &&
      inner._tag !== "Opened" &&
      inner._tag !== "PressedPointerOnButton" &&
      inner._tag !== "ClickedButton"
    )
      return { model };
    const result = menu.update(row.menu, inner);
    // Keep the anchor mode for the lifetime of the open panel.
    const nextRow = {
      ...row,
      menu: result.model,
      point:
        !row.menu.isOpen && message._tag === "OpenedContext"
          ? message.point
          : row.point,
      returnToRow:
        row.returnToRow || (!row.menu.isOpen && message._tag !== "GotMenu"),
    };
    const commands = Command.mapMessages(
      result.commands?.filter(
        ({ name }) => !row.returnToRow || name !== Menu.FocusButton.name,
      ),
      (message) => Message.GotMenu({ key, message }),
    );
    return {
      model: {
        ...model,
        row: result.model.isOpen
          ? nextRow
          : { ...nextRow, point: null, returnToRow: false },
      },
      commands:
        row.returnToRow &&
        result.commands?.some(({ name }) => name === Menu.FocusButton.name)
          ? [...commands, RestoreRowFocus({ id: rowLinkId(model.id, key) })]
          : commands,
      ...(result.outMessage
        ? { outMessage: { key, action: result.outMessage.value } }
        : {}),
    };
  };
};
