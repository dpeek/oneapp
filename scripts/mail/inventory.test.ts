import { expect, it, vi } from "@effect/vitest";
import type { ImapFlow } from "imapflow";
import { inventoryMailbox } from "./inventory.ts";

const setup = () => {
  const client = {
    list: vi.fn(async () => [
      {
        path: "INBOX",
        flags: new Set(),
        specialUse: "\\Inbox",
        specialUseSource: "name",
      },
      { path: "Archive", flags: new Set() },
      { path: "Folders", flags: new Set(["\\Noselect"]) },
    ]),
    mailboxOpen: vi.fn(async (path: string) => ({
      uidValidity: 123n,
      uidNext: path === "INBOX" ? 10 : 1,
      exists: path === "INBOX" ? 2 : 0,
      readOnly: true,
    })),
    fetch: vi.fn(async function* () {
      yield { uid: 3, size: 100, flags: new Set(["\\Seen"]) };
      yield { uid: 9, size: 200, flags: new Set(["\\Flagged", "\\Deleted"]) };
    }),
  };
  return { client, run: () => inventoryMailbox(client as unknown as ImapFlow) };
};

it("inventories metadata in read-only mode, bounds UIDs, and skips empty/nonselectable folders", async () => {
  const { client, run } = setup();
  const result = await run();
  expect(result).toMatchObject({ complete: true, messages: 2, bytes: 300 });
  expect(result.folders[0]).toMatchObject({
    uidValidity: "123",
    unread: 1,
    flagged: 1,
    deleted: 1,
  });
  expect(client.mailboxOpen.mock.calls).toEqual([
    ["INBOX", { readOnly: true }],
    ["Archive", { readOnly: true }],
  ]);
  expect(client.fetch.mock.calls).toEqual([
    ["1:9", { uid: true, size: true, flags: true }, { uid: true }],
  ]);
});

it("uses read-only EXAMINE even when iCloud reports readOnly:false", async () => {
  const { client, run } = setup();
  client.mailboxOpen.mockResolvedValueOnce({
    uidValidity: 123n,
    uidNext: 10,
    exists: 2,
    readOnly: false,
  });
  expect((await run()).complete).toBe(true);
  expect(client.mailboxOpen).toHaveBeenCalledWith("INBOX", { readOnly: true });
  expect(client.fetch.mock.calls).toEqual([
    ["1:9", { uid: true, size: true, flags: true }, { uid: true }],
  ]);
});

it("reports partial failures without exposing server errors and continues other folders", async () => {
  const { client, run } = setup();
  client.fetch.mockImplementation(async function* () {
    yield { uid: 3, size: 100, flags: new Set(["\\Seen"]) };
    throw new Error("private server details");
  });
  const report = await run();
  expect(report).toMatchObject({ complete: false, messages: 1, bytes: 100 });
  expect(report.folders[1]?.complete).toBe(true);
  expect(JSON.stringify(report)).not.toContain("private server details");
});

it("marks a changing mailbox inventory incomplete", async () => {
  const { client, run } = setup();
  client.fetch.mockImplementation(async function* () {
    yield { uid: 9, size: 200, flags: new Set() };
  });
  expect((await run()).folders[0]).toMatchObject({
    complete: false,
    messagesAtOpen: 2,
    messages: 1,
  });
});
