import { expect, it, vi } from "@effect/vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { atomicJson, sha256 } from "./files.ts";
import {
  exportSnapshot,
  inventorySnapshot,
  readInventory,
  snapshotBody,
  validateSnapshot,
} from "./snapshot.ts";

const bytes = Buffer.from(
  "From: a@example.test\r\nMessage-ID: <test@example.test>\r\n\r\nOriginal\x00\xff",
);
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "oneapp-snapshot-"));
  const client = {
    mailboxOpen: vi.fn(async () => ({
      uidValidity: 123n,
      uidNext: 3,
      exists: 2,
    })),
    fetch: vi.fn(async function* () {
      for (const uid of [1, 2])
        yield {
          uid,
          flags: new Set(uid === 1 ? ["\\Seen"] : []),
          internalDate: new Date(1_600_000_000_000 + uid),
          size: bytes.length,
        };
    }),
    download: vi.fn(async () => ({
      meta: {},
      content: Readable.from([bytes]),
    })),
  };
  const source = client as unknown as Parameters<typeof inventorySnapshot>[0];
  const inventory = await inventorySnapshot(source, "icloud:test@icloud.com", [
    "INBOX",
  ]);
  await atomicJson(join(directory, "inventory.json"), inventory);
  return {
    directory,
    client,
    source,
    inventory,
    [Symbol.asyncDispose]: () =>
      rm(directory, { recursive: true, force: true }),
  };
};

it("exports exact bytes with source-only metadata, checksums and private files", async () => {
  await using f = await fixture();
  const report = await exportSnapshot(f.directory, f.source);
  expect(report).toMatchObject({
    complete: true,
    downloaded: 2,
    reused: 0,
    bytes: bytes.length * 2,
  });
  const { inventory, manifest } = await validateSnapshot(f.directory);
  expect(inventory.messages[0]).toMatchObject({
    flags: ["\\Seen"],
    internalDate: 1_600_000_000_001,
  });
  expect(inventory.messages[0]).not.toHaveProperty("folder");
  expect(inventory.messages[0]).not.toHaveProperty("archived");
  expect(manifest.files.every((file) => file.sha256 === sha256(bytes))).toBe(
    true,
  );
  const path = snapshotBody(f.directory, inventory.messages[0]!.id);
  expect(await readFile(path)).toEqual(bytes);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(f.client.download.mock.calls[0]).toEqual([
    "1",
    undefined,
    {
      uid: true,
      binary: false,
      maxBytes: bytes.length + 1,
      chunkSize: 4 * 1024 * 1024,
    },
  ]);
  expect(f.client.mailboxOpen).toHaveBeenCalledWith("INBOX", {
    readOnly: true,
  });
});

it("resumes an interrupted stream without downloading completed files again", async () => {
  await using f = await fixture();
  f.client.download.mockResolvedValueOnce({
    meta: {},
    content: Readable.from([bytes]),
  });
  f.client.download.mockResolvedValueOnce({
    meta: {},
    content: Readable.from(
      (async function* () {
        yield bytes.subarray(0, 10);
        throw new Error("Disconnected");
      })(),
    ),
  });
  expect((await exportSnapshot(f.directory, f.source)).complete).toBe(false);
  await expect(validateSnapshot(f.directory)).rejects.toThrow("incomplete");
  f.client.download.mockClear();
  const resumed = await exportSnapshot(f.directory, f.source);
  expect(resumed).toMatchObject({ complete: true, downloaded: 1, reused: 1 });
  expect(f.client.download).toHaveBeenCalledTimes(1);
  await validateSnapshot(f.directory);
});

it("refuses changed source epochs before downloading", async () => {
  await using f = await fixture();
  f.client.mailboxOpen.mockResolvedValue({
    uidValidity: 124n,
    uidNext: 3,
    exists: 2,
  });
  await expect(exportSnapshot(f.directory, f.source)).rejects.toThrow(
    "UIDVALIDITY",
  );
  expect(f.client.download).not.toHaveBeenCalled();
});

it("assigns each message once across independent read-only connections", async () => {
  await using f = await fixture();
  await using other = await fixture();
  const report = await exportSnapshot(f.directory, f.source, () => {}, [
    other.source,
  ]);
  expect(report).toMatchObject({ complete: true, downloaded: 2 });
  expect(f.client.download).toHaveBeenCalledTimes(1);
  expect(other.client.download).toHaveBeenCalledTimes(1);
  expect(f.client.download).toHaveBeenCalledWith(
    "1",
    undefined,
    expect.any(Object),
  );
  expect(other.client.download).toHaveBeenCalledWith(
    "2",
    undefined,
    expect.any(Object),
  );
  expect(other.client.mailboxOpen).toHaveBeenLastCalledWith("INBOX", {
    readOnly: true,
  });
  await validateSnapshot(f.directory);
});

it("never completes a snapshot containing truncated or oversized files", async () => {
  await using f = await fixture();
  f.client.download.mockResolvedValueOnce({
    meta: {},
    content: Readable.from([bytes.subarray(0, 5)]),
  });
  f.client.download.mockResolvedValueOnce({
    meta: {},
    content: Readable.from([Buffer.concat([bytes, bytes])]),
  });
  const report = await exportSnapshot(f.directory, f.source);
  expect(report).toMatchObject({ complete: false, downloaded: 0 });
  expect(report.failures).toHaveLength(2);
  await expect(validateSnapshot(f.directory)).rejects.toThrow("incomplete");
});

it("rejects tampered metadata and body bytes before replay", async () => {
  await using f = await fixture();
  await exportSnapshot(f.directory, f.source);
  const path = snapshotBody(f.directory, f.inventory.messages[0]!.id);
  await writeFile(path, Buffer.alloc(bytes.length, 42));
  await expect(validateSnapshot(f.directory)).rejects.toThrow("checksum");
  await writeFile(path, bytes);
  await atomicJson(join(f.directory, "inventory.json"), {
    ...f.inventory,
    createdAt: "changed",
  });
  await expect(validateSnapshot(f.directory)).rejects.toThrow("manifest");
});

it("rejects duplicate or mismatched source identities in the inventory", async () => {
  await using f = await fixture();
  await atomicJson(join(f.directory, "inventory.json"), {
    ...f.inventory,
    messages: [f.inventory.messages[0], f.inventory.messages[0]],
  });
  await expect(readInventory(f.directory)).rejects.toThrow("identities");
});
