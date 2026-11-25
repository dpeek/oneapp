import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Dialog } from "@oneapp/ui";
import { initial, Message, update } from "./inbox-attachments.ts";

vi.mock("@oneapp/ui", async () => {
  const { Dialog } = await import(
    import.meta.resolve("@foldkit/ui", import.meta.resolve("@oneapp/ui"))
  );
  return { Dialog };
});

it("ignores a loading attachment's result after closing and reopening its preview", () => {
  const id = "0-8199999999990-00000000-0000-4000-8000-000000000000.eml";
  const open = () => Message.Opened({ id, part: 0 });
  const first = update(initial, open()).model;
  const closed = update(
    first,
    Message.GotDialogMessage({ message: Dialog.Message.RequestedClose() }),
  ).model;
  expect(closed.dialog.isOpen).toBe(false);
  expect(closed.preview).toBeNull();

  const second = update(closed, open()).model;
  const ready = Message.Ready({ request: first.preview!.request });
  expect(second.dialog.isOpen).toBe(true);
  expect(update(closed, ready).model).toBe(closed);
  expect(update(second, ready).model).toBe(second);
  expect(
    update(second, Message.Ready({ request: second.preview!.request })).model
      .preview?.status,
  ).toBe("ready");
});
