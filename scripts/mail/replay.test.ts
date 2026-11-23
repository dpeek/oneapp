import { expect, it, vi } from "@effect/vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MailMapping,
  SnapshotInventory,
  SnapshotManifest,
} from "../../packages/core/src/mail-snapshot.ts";
import {
  mappingHash,
  previewMapping,
  replaySnapshot,
  type SnapshotSink,
} from "./replay.ts";
import { sha256 } from "./files.ts";
import { snapshotBody, sourceId } from "./snapshot.ts";

const mapping: MailMapping = {
  format: "oneapp-mail-mapping",
  version: 1,
  folders: {
    INBOX: { folder: "inbox", archived: false },
    Archive: { folder: "inbox", archived: true },
  },
};
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "oneapp-replay-"));
  await mkdir(join(directory, "messages"));
  const bytes = new TextEncoder().encode(
    "From: a@example.test\r\n\r\nOriginal body",
  );
  const inventory: SnapshotInventory = {
    format: "oneapp-mail-snapshot",
    version: 1,
    snapshotId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    source: {
      protocol: "imap",
      host: "imap.mail.me.com",
      account: "icloud:test@icloud.com",
    },
    folders: ["INBOX", "Archive"].map((path) => ({
      path,
      uidValidity: 1,
      uidNext: 2,
      messages: 1,
    })),
    messages: ["INBOX", "Archive"].map((mailbox) => {
      const source = {
        account: "icloud:test@icloud.com",
        mailbox,
        uidValidity: 1,
        uid: 1,
      };
      return {
        id: sourceId(source),
        source,
        internalDate: 1_600_000_000_000,
        flags: ["\\Seen"],
        size: bytes.length,
      };
    }),
  };
  const manifest: SnapshotManifest = {
    format: "oneapp-mail-snapshot",
    version: 1,
    snapshotId: inventory.snapshotId,
    inventorySha256: sha256(JSON.stringify(inventory)),
    completedAt: new Date().toISOString(),
    files: inventory.messages.map((entry) => ({
      id: entry.id,
      sha256: sha256(bytes),
      size: bytes.length,
    })),
  };
  for (const entry of inventory.messages)
    await writeFile(snapshotBody(directory, entry.id), bytes);
  return {
    directory,
    inventory,
    manifest,
    bytes,
    [Symbol.asyncDispose]: () =>
      rm(directory, { recursive: true, force: true }),
  };
};
const sink = () => {
  const receipts = new Map<
    string,
    NonNullable<Awaited<ReturnType<SnapshotSink["receipt"]>>>
  >();
  const api: SnapshotSink = {
    receipt: vi.fn(async (source) => receipts.get(sourceId(source)) ?? null),
    ingest: vi.fn<SnapshotSink["ingest"]>(async (metadata, raw) => {
      const id = sourceId(metadata.source);
      receipts.set(id, {
        id,
        sha256: sha256(raw),
        metadata: JSON.stringify(metadata),
        completedAt: 1,
      });
      return { status: "imported", id };
    }),
  };
  return { ...api, receipts };
};

it("replays one immutable snapshot with different mappings into fresh destinations", async () => {
  await using f = await fixture();
  const first = sink();
  const second = sink();
  const changed: MailMapping = {
    ...mapping,
    folders: {
      ...mapping.folders,
      Archive: { folder: "inbox", archived: false },
    },
  };
  expect(
    (await replaySnapshot(f.directory, f.inventory, f.manifest, mapping, first))
      .imported,
  ).toBe(2);
  expect(
    (
      await replaySnapshot(
        f.directory,
        f.inventory,
        f.manifest,
        changed,
        second,
      )
    ).imported,
  ).toBe(2);
  const archived = f.inventory.messages[1]!.id;
  expect(JSON.parse(first.receipts.get(archived)!.metadata).archived).toBe(
    true,
  );
  expect(JSON.parse(second.receipts.get(archived)!.metadata).archived).toBe(
    false,
  );
  expect(await readFile(snapshotBody(f.directory, archived))).toEqual(
    Buffer.from(f.bytes),
  );
  expect(mappingHash(mapping)).not.toBe(mappingHash(changed));
});

it("skips completed imports and refuses reinterpretation in an existing destination", async () => {
  await using f = await fixture();
  const target = sink();
  await replaySnapshot(f.directory, f.inventory, f.manifest, mapping, target);
  vi.mocked(target.ingest).mockClear();
  expect(
    (
      await replaySnapshot(
        f.directory,
        f.inventory,
        f.manifest,
        mapping,
        target,
      )
    ).skipped,
  ).toBe(2);
  expect(target.ingest).not.toHaveBeenCalled();
  const changed: MailMapping = {
    ...mapping,
    folders: {
      ...mapping.folders,
      Archive: { folder: "sent", archived: false },
    },
  };
  await expect(
    replaySnapshot(f.directory, f.inventory, f.manifest, changed, target),
  ).rejects.toThrow("conflicting");
});

it("retries failed messages while preserving completed receipts", async () => {
  await using f = await fixture();
  const target = sink();
  vi.mocked(target.ingest).mockResolvedValueOnce({ status: "failed" });
  expect(
    await replaySnapshot(f.directory, f.inventory, f.manifest, mapping, target),
  ).toMatchObject({ complete: false, imported: 1, failed: 1 });
  expect(
    await replaySnapshot(f.directory, f.inventory, f.manifest, mapping, target),
  ).toMatchObject({ complete: true, imported: 1, skipped: 1 });
});

it("validates mappings before any destination mutation and supports explicit exclusion", async () => {
  await using f = await fixture();
  const target = sink();
  const invalid = { ...mapping, folders: { INBOX: mapping.folders.INBOX! } };
  expect(() => previewMapping(f.inventory, invalid)).toThrow("explicit");
  await expect(
    replaySnapshot(f.directory, f.inventory, f.manifest, invalid, target),
  ).rejects.toThrow();
  expect(target.ingest).not.toHaveBeenCalled();
  const excluded: MailMapping = {
    ...mapping,
    folders: { ...mapping.folders, Archive: { skip: true } },
  };
  expect(
    await replaySnapshot(
      f.directory,
      f.inventory,
      f.manifest,
      excluded,
      target,
    ),
  ).toMatchObject({ complete: true, imported: 1, excluded: 1 });
});

it("detects body changes between preflight validation and ingestion", async () => {
  await using f = await fixture();
  const target = sink();
  await writeFile(
    snapshotBody(f.directory, f.inventory.messages[0]!.id),
    Buffer.alloc(f.bytes.length),
  );
  await expect(
    replaySnapshot(f.directory, f.inventory, f.manifest, mapping, target),
  ).rejects.toThrow("changed after validation");
  expect(target.ingest).not.toHaveBeenCalled();
});

it("reports originals too large for the local adapter without losing them from the snapshot", async () => {
  await using f = await fixture();
  const target = sink();
  const inventory = {
    ...f.inventory,
    messages: [{ ...f.inventory.messages[0]!, size: 26 * 1024 * 1024 }],
  };
  const result = await replaySnapshot(
    f.directory,
    inventory,
    f.manifest,
    mapping,
    target,
  );
  expect(result).toMatchObject({ complete: false, oversized: 1, imported: 0 });
  expect(target.ingest).not.toHaveBeenCalled();
});
