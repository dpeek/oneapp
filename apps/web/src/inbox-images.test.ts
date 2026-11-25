import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
// Exercise the installed menu state machine without compiling UI styles.
vi.mock("@oneapp/ui", async () => {
  const { Menu, Dialog, Popover } = await import(
    import.meta.resolve("@foldkit/ui", import.meta.resolve("@oneapp/ui"))
  );
  return {
    Dialog,
    DropdownMenu: Menu,
    Sheet: Dialog,
    Popover,
    Toast: await import("../../../packages/ui/src/toast-state.ts"),
  };
});
import { DropdownMenu } from "@oneapp/ui";
import { initial, Message, update } from "./inbox.ts";

const id = "0-8199999999990-00000000-0000-4000-8000-000000000000.eml";
const remoteImages = { available: 1, blocked: 1, loaded: 0, unavailable: 0 };
const entry = {
  id,
  from: "sender@example.com",
  to: "me@example.com",
  subject: "Newsletter",
  receivedAt: 1,
  text: "Plain body",
  html: "<p>Formatted body</p>",
  preview: "complete" as const,
  remoteImages,
};
const opened = () =>
  update(
    {
      ...initial,
      active: { id, folder: "inbox" },
      selected: id,
      entryRequest: "body-request",
    },
    Message.LoadedEntry({ request: "body-request", entry }),
  );
const action = (value: string) =>
  Message.GotMessageMenuMessage({
    message: DropdownMenu.Message.SelectedItem({ item: value, index: 0 }),
  });

it("shows the body before images arrive, retaining the current read state", () => {
  const result = opened();
  expect(result.model.entry?.html).toBe(entry.html);
  expect(result.commands?.[0]?.args).toMatchObject({
    id,
    includeBlocked: false,
  });
  const complete = update(
    { ...result.model, entry: { ...entry, unread: false } },
    Message.LoadedImages({
      request: result.model.imageRequest!,
      id,
      html: "<p>With image</p>",
      remoteImages: { ...remoteImages, loaded: 1 },
    }),
  );
  expect(complete.model.entry).toMatchObject({
    html: "<p>With image</p>",
    unread: false,
  });
});

it("switches between plain and formatted views through the menu and resets for another message", () => {
  let model = opened().model;
  model = update(model, action("togglePlainText")).model;
  expect(model.showPlainText).toBe(true);
  model = update(model, action("togglePlainText")).model;
  expect(model.showPlainText).toBe(false);
  model = update(model, action("togglePlainText")).model;
  const switched = update(
    model,
    Message.ToggledMessage({ id: id.replace("9990", "9991"), folder: "inbox" }),
  ).model;
  expect(switched.showPlainText).toBe(false);
  expect(switched.imageRequest).toBeNull();
  const late = update(
    switched,
    Message.LoadedImages({
      request: model.imageRequest!,
      id,
      html: "Old message",
      remoteImages,
    }),
  );
  expect(late.model).toBe(switched);
});

it("only loads blocked images through the explicit menu action and ignores duplicate requests", () => {
  const model = { ...opened().model, imageRequest: null };
  const result = update(model, action("loadBlockedImages"));
  expect(
    result.commands?.some(
      (command) =>
        command.args &&
        "includeBlocked" in command.args &&
        command.args.includeBlocked,
    ),
  ).toBe(true);
  expect(
    update(result.model, action("loadBlockedImages")).commands,
  ).not.toContainEqual(result.commands?.at(-1));
  expect(result.model.entry?.html).toBe(entry.html);
});

it("opens Trash messages directly without loading a conversation or changing read state", () => {
  const opened = update(initial, Message.Opened({ folder: "trash", id }));
  expect(opened.model.threadRequest).toBeNull();
  expect(
    opened.commands?.some(
      (command) =>
        command.args && "trash" in command.args && command.args.trash,
    ),
  ).toBe(true);
  const loaded = update(
    opened.model,
    Message.LoadedEntry({
      request: opened.model.entryRequest!,
      entry: { ...entry, unread: true },
    }),
  );
  expect(loaded.model.readRequests).toEqual({});
  expect(loaded.model.entry).toMatchObject({ unread: true });
  expect(loaded.commands?.[0]?.args).toMatchObject({
    trash: true,
    includeBlocked: false,
  });
  const restoring = update(loaded.model, action("restore"));
  expect(restoring.model.recovery.restoring).toBe(id);
  const stale = update(
    restoring.model,
    Message.GotRecoveryMessage({
      message: { _tag: "Restored", request: "stale", id },
    }),
  );
  expect(stale.model.selected).toBe(id);
  const restored = update(
    restoring.model,
    Message.GotRecoveryMessage({
      message: {
        _tag: "Restored",
        request: restoring.model.recovery.request!,
        id,
      },
    }),
  );
  expect(restored.model.selected).toBeNull();
  expect(restored.model.entry).toBeNull();
  expect(restored.model.recovery.request).toBeNull();
  expect(restored.model.listRefreshQueued).toBe(true);
});
