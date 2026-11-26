import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
vi.mock("@orumai/ui", async () => ({
  Toast: await import("../../../packages/ui/src/toast-state.ts"),
}));
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

it("updates a loaded list without clearing the separate Links form draft", () => {
  const older = { id: "older-link", url: "https://example.org", savedAt: 1 };
  const { model: pending } = submittedCreation({
    ...initial,
    records: [older],
    url: "unsaved.example.org",
  });
  const { model: saved } = update(
    pending,
    Message.Saved({ request: pending.request!.id, link }),
  );
  expect(saved.records).toEqual([link, older]);
  expect(saved.url).toBe("unsaved.example.org");
});
