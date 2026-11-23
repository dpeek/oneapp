import type {
  MailMapping,
  MailSource,
  SnapshotInventory,
  SnapshotManifest,
} from "../../packages/core/src/mail-snapshot.ts";
import type { MailImportMetadata } from "../../apps/web/src/server/mail-import.ts";
import { MailSampleError } from "./errors.ts";
import { sha256 } from "./files.ts";
import { snapshotBody } from "./snapshot.ts";

export type SnapshotSink = {
  receipt(source: typeof MailSource.Type): Promise<{
    id: string;
    sha256: string;
    metadata: string;
    completedAt: number | null;
  } | null>;
  ingest(
    metadata: MailImportMetadata,
    raw: Uint8Array<ArrayBuffer>,
  ): Promise<{ status: "imported" | "skipped" | "failed"; id?: string }>;
};
export const mappingHash = (mapping: MailMapping) =>
  sha256(
    JSON.stringify({
      version: mapping.version,
      folders: Object.fromEntries(
        Object.entries(mapping.folders).sort(([a], [b]) => a.localeCompare(b)),
      ),
    }),
  );

export const previewMapping = (
  inventory: SnapshotInventory,
  mapping: MailMapping,
) =>
  inventory.folders.map((folder) => {
    const target = mapping.folders[folder.path];
    if (
      !target ||
      (!("skip" in target) && target.folder === "sent" && target.archived)
    )
      throw new MailSampleError(
        "Every source folder needs an explicit valid mapping or skip rule.",
      );
    return {
      source: folder.path,
      target,
      messages: folder.messages,
      bytes: inventory.messages
        .filter((message) => message.source.mailbox === folder.path)
        .reduce((sum, entry) => sum + entry.size, 0),
    };
  });

export const replaySnapshot = async (
  directory: string,
  inventory: SnapshotInventory,
  manifest: SnapshotManifest,
  mapping: MailMapping,
  sink: SnapshotSink,
  progress: (done: number, total: number) => void = () => {},
) => {
  previewMapping(inventory, mapping);
  const files = new Map(manifest.files.map((file) => [file.id, file]));
  const results: { sourceId: string; status: string; id?: string }[] = [];
  for (const entry of inventory.messages) {
    const target = mapping.folders[entry.source.mailbox]!;
    if ("skip" in target) {
      results.push({ sourceId: entry.id, status: "excluded" });
      continue;
    }
    const expected = files.get(entry.id)!;
    const metadata: MailImportMetadata = {
      source: entry.source,
      folder: target.folder,
      archived: target.archived,
      timestamp: entry.internalDate,
      flags: entry.flags,
    };
    const receipt = await sink.receipt(entry.source);
    if (receipt) {
      const initial: MailImportMetadata = JSON.parse(receipt.metadata);
      if (
        receipt.sha256 !== expected.sha256 ||
        initial.folder !== metadata.folder ||
        initial.archived !== metadata.archived ||
        initial.timestamp !== metadata.timestamp
      )
        throw new MailSampleError(
          "Destination has a conflicting import interpretation or checksum. Reprocess into a fresh stage.",
        );
      if (receipt.completedAt !== null) {
        results.push({ sourceId: entry.id, status: "skipped", id: receipt.id });
        progress(results.length, inventory.messages.length);
        continue;
      }
    }
    // Local RPC and the current mail reader are bounded to 25 MiB per message.
    // The snapshot retains larger originals for a future streaming adapter.
    if (entry.size > 25 * 1024 * 1024)
      results.push({
        sourceId: entry.id,
        status: "oversized-for-local-import",
      });
    else {
      const bytes = new Uint8Array(
        await Bun.file(snapshotBody(directory, entry.id)).arrayBuffer(),
      );
      if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256)
        throw new MailSampleError(
          "Snapshot changed after validation. Import stopped.",
        );
      results.push({
        sourceId: entry.id,
        ...(await sink.ingest(metadata, bytes)),
      });
    }
    progress(results.length, inventory.messages.length);
  }
  const count = (status: string) =>
    results.filter((entry) => entry.status === status).length;
  return {
    complete: results.every((entry) =>
      ["imported", "skipped", "excluded"].includes(entry.status),
    ),
    imported: count("imported"),
    skipped: count("skipped"),
    excluded: count("excluded"),
    failed: count("failed"),
    oversized: count("oversized-for-local-import"),
    results,
  };
};
