import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
vi.mock("@orumai/ui", async () => {
  const state =
    await import("../../../packages/ui/src/item-action-menu-state.ts");
  return {
    ItemActionMenu: {
      ...state,
      create: () => ({ update: state.createUpdate() }),
    },
    Toast: await import("../../../packages/ui/src/toast-state.ts"),
  };
});
import { ItemActionMenu } from "@orumai/ui";
import { initial, Message, update } from "./links.ts";

const link = { id: "new-link", url: "https://example.com", savedAt: 2 };

const openedCreation = (model = initial) =>
  update(model, Message.OpenedCreate()).model;

const submittedCreation = (model = initial) => {
  const edited = update(
    openedCreation(model),
    Message.EditedCreateUrl({ url: " example.com/ " }),
  ).model;
  return update(edited, Message.SubmittedCreate());
};

it("saves from an unloaded screen and still loads the full link list on first visit", () => {
  const { model: pending, commands } = submittedCreation();
  expect(commands).toHaveLength(1);
  expect(update(pending, Message.SubmittedCreate()).commands).toBeUndefined();
  const { model: saved, outMessage } = update(
    pending,
    Message.Saved({ request: pending.request!.id, link }),
  );
  expect(outMessage?._tag).toBe("Created");
  expect(saved.creation).toBeNull();
  expect(saved.records).toBeNull();
  expect(update(saved, Message.Requested()).commands).toHaveLength(1);
});

it("updates a loaded list and closes the dialog after saving", () => {
  const older = { id: "older-link", url: "https://example.org", savedAt: 1 };
  const { model: pending, commands } = submittedCreation({
    ...initial,
    records: [older],
  });
  expect(commands?.[0]?.args).toMatchObject({ url: link.url });
  const message = Message.Saved({ request: pending.request!.id, link });
  const { model: saved, outMessage } = update(pending, message);
  expect(saved.records).toEqual([link, older]);
  expect(saved.creation).toBeNull();
  expect(outMessage?._tag).toBe("Created");
  expect(update(saved, message).outMessage).toBeUndefined();
});

it("deletes the open menu's link after reordering and focuses the surviving neighbor", () => {
  const older = { id: "older-link", url: "https://example.org", savedAt: 1 };
  const dispatchMenu = (
    model: typeof initial,
    message: typeof ItemActionMenu.Message.Type,
  ) => update(model, Message.GotActionMenu({ message }));
  const { model: opened } = dispatchMenu(
    { ...initial, records: [older, link] },
    ItemActionMenu.Message.OpenedContext({
      key: older.id,
      point: { x: 40, y: 80 },
    }),
  );
  const reordered = { ...opened, records: [link, older] };
  const selectDelete = (key: string) =>
    ItemActionMenu.Message.GotMenu({
      key,
      message: { _tag: "SelectedItem", index: 2, item: "delete" },
    });
  expect(dispatchMenu(reordered, selectDelete(link.id)).model.actions).toBe(
    opened.actions,
  );
  const { model: pending } = dispatchMenu(reordered, selectDelete(older.id));
  expect(pending.request?.linkId).toBe(older.id);
  expect(pending.actions.row?.menu.isOpen).toBe(false);

  const { model: deleted, commands } = update(
    pending,
    Message.Deleted({ request: pending.request!.id, id: older.id }),
  );
  expect(deleted.records).toEqual([link]);
  expect(deleted.actions.row).toBeNull();
  expect(commands?.[0]?.args).toEqual({
    neighborId: link.id,
  });
});
