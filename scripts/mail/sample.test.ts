import { expect, it, vi } from "@effect/vitest";
import type { ImapFlow } from "imapflow";
import {
  runSample,
  selectSample,
  planSample,
  sampleLimits,
  type SamplePlan,
  type SampleSink,
} from "./sample.ts";

const message = (
  uid: number,
  mailbox = "INBOX",
  ids = [`<${uid}@example.test>`],
  size = 100,
) => ({
  metadata: {
    source: { account: "icloud:test@icloud.com", mailbox, uidValidity: 1, uid },
    folder:
      mailbox === "Sent Messages" ? ("sent" as const) : ("inbox" as const),
    archived: mailbox === "Archive",
    timestamp: 1000 + uid,
    flags: ["\\Seen"],
  },
  size,
  threadIds: ids,
});
const plan = (messages = [message(1), message(2)]): SamplePlan => ({
  version: 1,
  account: "icloud:test@icloud.com",
  stage: "test",
  resources: { inbox: "dev:inbox", sent: "dev:sent", database: "dev:db" },
  createdAt: "2026-11-23T00:00:00.000Z",
  messages,
  excludedThreads: 0,
});

it("selects recent seeds and expands threads across Inbox and Sent", () => {
  const candidates = Array.from({ length: 20 }, (_, i) => message(i + 1));
  candidates.push(
    message(21, "Sent Messages", ["<1@example.test>", "<21@example.test>"]),
  );
  const selected = selectSample(candidates);
  expect(selected.messages.map((entry) => entry.metadata.source.uid)).toContain(
    1,
  );
  expect(selected.messages.map((entry) => entry.metadata.source.uid)).toContain(
    21,
  );
  expect(selected.messages).toHaveLength(11);
});

it("skips whole oversized threads and stays within both total bounds", () => {
  const selected = selectSample([
    message(1, "INBOX", ["<thread@test>"], sampleLimits.messageBytes + 1),
    message(1000, "Sent Messages", ["<thread@test>"], 100),
    ...Array.from({ length: 12 }, (_, i) =>
      message(i + 2, "INBOX", [`<small${i}@test>`], 20 * 1024 * 1024),
    ),
  ]);
  expect(selected.messages).toHaveLength(5);
  expect(
    selected.messages.some((entry) =>
      [1, 1000].includes(entry.metadata.source.uid),
    ),
  ).toBe(false);
  expect(selected.messages.reduce((sum, entry) => sum + entry.size, 0)).toBe(
    sampleLimits.bytes,
  );
  expect(selected.excludedThreads).toBeGreaterThan(0);
  const largeThread = Array.from({ length: 101 }, (_, i) =>
    message(i, "INBOX", ["<same@test>"]),
  );
  expect(selectSample(largeThread).messages).toHaveLength(0);
});

const setup = () => {
  const completed = new Map<number, string>();
  const client = {
    mailboxOpen: vi.fn(async () => ({
      uidValidity: 1n,
      uidNext: 3,
      exists: 2,
    })),
    fetch: vi.fn(async function* () {
      for (const uid of [1, 2])
        yield {
          uid,
          size: 100,
          flags: new Set(["\\Seen"]),
          internalDate: new Date(1000 + uid),
          headers: Buffer.from(`Message-ID: <${uid}@test>\r\n\r\n`),
        };
    }),
    fetchOne: vi.fn(async (uid: string) => ({
      uid: Number(uid),
      source: Buffer.alloc(100, 42),
    })),
  };
  const sink: SampleSink = {
    completed: vi.fn(async (source) => completed.get(source.uid) ?? null),
    ingest: vi.fn(async (metadata, _bytes) => {
      completed.set(metadata.source.uid, `import-${metadata.source.uid}`);
      return {
        status: "imported" as const,
        id: `import-${metadata.source.uid}`,
      };
    }),
  };
  return { client, source: client as unknown as ImapFlow, sink, completed };
};

it("plans from metadata without downloading bodies or changing source flags", async () => {
  const { source, client } = setup();
  const result = await planSample(source, "icloud:test@icloud.com");
  expect(result.messages).toHaveLength(6);
  expect(client.fetchOne).not.toHaveBeenCalled();
  expect(client.mailboxOpen.mock.calls).toEqual([
    ["INBOX", { readOnly: true }],
    ["Sent Messages", { readOnly: true }],
    ["Archive", { readOnly: true }],
  ]);
  expect(client.fetch.mock.calls[0]).toEqual([
    "1:2",
    {
      uid: true,
      size: true,
      flags: true,
      internalDate: true,
      headers: ["message-id", "references", "in-reply-to"],
    },
    { uid: true },
  ]);
});

it("bounds raw fetches, preserves snapshot metadata, and skips completed bodies on rerun", async () => {
  const { source, client, sink } = setup();
  expect((await runSample(source, sink, plan())).complete).toBe(true);
  expect(client.fetchOne.mock.calls).toEqual([
    ["1", { uid: true, source: { maxLength: 101 } }, { uid: true }],
    ["2", { uid: true, source: { maxLength: 101 } }, { uid: true }],
  ]);
  expect(sink.ingest).toHaveBeenCalledWith(
    plan().messages[0]!.metadata,
    new Uint8Array(100).fill(42),
  );
  client.fetchOne.mockClear();
  const rerun = await runSample(source, sink, plan());
  expect(rerun.results.map((entry) => entry.status)).toEqual([
    "skipped",
    "skipped",
  ]);
  expect(client.fetchOne).not.toHaveBeenCalled();
});

it("keeps messages without threading headers as independent sample entries", async () => {
  const { source, client } = setup();
  client.fetch.mockImplementation(async function* () {
    yield {
      uid: 1,
      size: 100,
      flags: new Set(["\\Seen"]),
      internalDate: new Date(1001),
      headers: Buffer.from("\r\n"),
    };
  });
  expect(
    (await planSample(source, "icloud:test@icloud.com")).messages,
  ).toHaveLength(3);
});

it("reports a failed local write and retries it on the next run", async () => {
  const { source, sink } = setup();
  vi.mocked(sink.ingest).mockResolvedValueOnce({ status: "failed" });
  const first = await runSample(source, sink, plan());
  expect(first.complete).toBe(false);
  expect(first.results[0]?.status).toBe("failed");
  const retry = await runSample(source, sink, plan());
  expect(retry.complete).toBe(true);
  expect(retry.results.map((entry) => entry.status)).toEqual([
    "imported",
    "skipped",
  ]);
});

it("resumes after interruption without redownloading a successful message", async () => {
  const { source, client, sink } = setup();
  client.fetchOne.mockImplementationOnce(async () => ({
    uid: 1,
    source: Buffer.alloc(100),
  }));
  client.fetchOne.mockRejectedValueOnce(new Error("Disconnected"));
  await expect(runSample(source, sink, plan())).rejects.toThrow("Disconnected");
  const resumed = await runSample(source, sink, plan());
  expect(resumed.results.map((entry) => entry.status)).toEqual([
    "skipped",
    "imported",
  ]);
});

it("refuses changed UIDVALIDITY before transferring messages", async () => {
  const { source, client, sink } = setup();
  client.mailboxOpen.mockResolvedValue({
    uidValidity: 2n,
    uidNext: 3,
    exists: 2,
  });
  await expect(runSample(source, sink, plan())).rejects.toThrow("UIDVALIDITY");
  expect(client.fetchOne).not.toHaveBeenCalled();
  expect(sink.ingest).not.toHaveBeenCalled();
});

it("does not ingest missing or truncated source bytes and retries failed writes", async () => {
  const { source, client, sink } = setup();
  client.fetchOne.mockResolvedValueOnce({ uid: 1, source: Buffer.alloc(99) });
  const result = await runSample(source, sink, plan());
  expect(result.complete).toBe(false);
  expect(result.results[0]?.status).toBe("source-changed-or-missing");
  expect((await runSample(source, sink, plan())).complete).toBe(true);
});
