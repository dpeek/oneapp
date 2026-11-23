import {
  SnapshotFile,
  SnapshotInventory,
  SnapshotManifest,
  type SnapshotMessage,
} from "../../packages/core/src/mail-snapshot.ts";
import { Schema } from "effect";
import type { ImapFlow } from "imapflow";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { atomicJson, hashFile, sha256 } from "./files.ts";
import { MailSampleError } from "./errors.ts";

export const sourceId = (source: SnapshotMessage["source"]) =>
  sha256(
    JSON.stringify([
      source.account,
      source.mailbox,
      source.uidValidity,
      source.uid,
    ]),
  );
export const snapshotBody = (directory: string, id: string) =>
  join(directory, "messages", `${id}.eml`);
type Client = Pick<ImapFlow, "mailboxOpen" | "fetch" | "download">;
export const inventorySnapshot = async (
  client: Client,
  account: string,
  paths: readonly string[],
) => {
  const folders: SnapshotInventory["folders"][number][] = [];
  const messages: SnapshotMessage[] = [];
  for (const path of paths) {
    const mailbox = await client.mailboxOpen(path, { readOnly: true });
    const folder = {
      path,
      uidValidity: Number(mailbox.uidValidity),
      uidNext: mailbox.uidNext,
      messages: mailbox.exists,
    };
    folders.push(folder);
    let count = 0;
    if (folder.messages) {
      if (!Number.isSafeInteger(folder.uidNext) || folder.uidNext <= 1)
        throw new MailSampleError("Invalid source UID range.");
      for await (const mail of client.fetch(
        `1:${folder.uidNext - 1}`,
        { uid: true, flags: true, internalDate: true, size: true },
        { uid: true },
      )) {
        if (!mail.flags || !mail.internalDate)
          throw new MailSampleError("Incomplete source metadata.");
        const source = {
          account,
          mailbox: path,
          uidValidity: folder.uidValidity,
          uid: mail.uid,
        };
        messages.push({
          id: sourceId(source),
          source,
          internalDate: new Date(mail.internalDate).getTime(),
          flags: [...mail.flags],
          size: mail.size!,
        });
        count++;
      }
    }
    if (count !== folder.messages)
      throw new MailSampleError(
        "Mailbox changed during inventory. Retry to create a consistent selection.",
      );
  }
  return Schema.decodeUnknownSync(SnapshotInventory)({
    format: "oneapp-mail-snapshot",
    version: 1,
    snapshotId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    source: { protocol: "imap", host: "imap.mail.me.com", account },
    folders,
    messages,
  });
};

export const readInventory = async (directory: string) => {
  const raw = await Bun.file(join(directory, "inventory.json")).text();
  const inventory = Schema.decodeUnknownSync(SnapshotInventory)(
    JSON.parse(raw),
  );
  const folders = new Map(
    inventory.folders.map((folder) => [folder.path, folder]),
  );
  const ids = new Set<string>();
  if (folders.size !== inventory.folders.length)
    throw new MailSampleError("Snapshot has duplicate folders.");
  for (const entry of inventory.messages) {
    const folder = folders.get(entry.source.mailbox);
    if (
      !folder ||
      folder.uidValidity !== entry.source.uidValidity ||
      entry.source.uid >= folder.uidNext ||
      entry.source.account !== inventory.source.account ||
      entry.id !== sourceId(entry.source) ||
      ids.has(entry.id)
    )
      throw new MailSampleError("Snapshot source identities are inconsistent.");
    ids.add(entry.id);
  }
  for (const folder of folders.values())
    if (
      inventory.messages.filter((entry) => entry.source.mailbox === folder.path)
        .length !== folder.messages
    )
      throw new MailSampleError("Snapshot folder counts do not reconcile.");
  return { inventory, inventorySha256: sha256(raw) };
};

export const validateSnapshot = async (directory: string) => {
  const { inventory, inventorySha256 } = await readInventory(directory);
  if (!(await Bun.file(join(directory, "manifest.json")).exists()))
    throw new MailSampleError(
      "Snapshot is incomplete: resume mail:export before importing.",
    );
  const manifest = Schema.decodeUnknownSync(SnapshotManifest)(
    await Bun.file(join(directory, "manifest.json")).json(),
  );
  if (
    manifest.snapshotId !== inventory.snapshotId ||
    manifest.inventorySha256 !== inventorySha256 ||
    manifest.files.length !== inventory.messages.length
  )
    throw new MailSampleError(
      "Snapshot manifest does not match its inventory.",
    );
  const files = new Map(manifest.files.map((file) => [file.id, file]));
  if (files.size !== manifest.files.length)
    throw new MailSampleError("Snapshot contains duplicate file records.");
  for (const entry of inventory.messages) {
    const expected = files.get(entry.id);
    const path = snapshotBody(directory, entry.id);
    if (
      !expected ||
      !(await lstat(path)
        .then((file) => file.isFile())
        .catch(() => false))
    )
      throw new MailSampleError("Snapshot is missing an original email file.");
    const actual = await hashFile(path);
    if (
      expected.size !== entry.size ||
      actual.size !== expected.size ||
      actual.sha256 !== expected.sha256
    )
      throw new MailSampleError(
        "Snapshot checksum or size mismatch. No import should proceed.",
      );
  }
  return { inventory, manifest };
};

// Each completed body and receipt is published atomically. A partial body has
// no receipt and is downloaded again. No complete manifest exists until every
// inventory entry has been verified, including files from an earlier attempt.
export const exportSnapshot = async (
  directory: string,
  client: Client,
  progress: (done: number, total: number) => void = () => {},
  additionalClients: readonly Client[] = [],
) => {
  const { inventory, inventorySha256 } = await readInventory(directory);
  await mkdir(join(directory, "messages"), { recursive: true, mode: 0o700 });
  await mkdir(join(directory, "receipts"), { recursive: true, mode: 0o700 });
  const files: SnapshotFile[] = [];
  const failures: { id: string; reason: string }[] = [];
  let downloaded = 0;
  let reused = 0;
  const pending: SnapshotMessage[] = [];
  for (const folder of inventory.folders) {
    const entries = inventory.messages.filter(
      (entry) => entry.source.mailbox === folder.path,
    );
    for (const entry of entries) {
      const receiptPath = join(directory, "receipts", `${entry.id}.json`);
      if (await Bun.file(receiptPath).exists()) {
        const receipt = Schema.decodeUnknownSync(SnapshotFile)(
          await Bun.file(receiptPath).json(),
        );
        const actual = await hashFile(snapshotBody(directory, entry.id));
        if (
          receipt.id !== entry.id ||
          receipt.size !== entry.size ||
          receipt.size !== actual.size ||
          receipt.sha256 !== actual.sha256
        )
          throw new MailSampleError(
            "A completed export file changed. Restore it or export into a new directory.",
          );
        files.push(receipt);
        reused++;
        progress(files.length, inventory.messages.length);
      } else pending.push(entry);
    }
  }
  // Each connection owns its selected mailbox and finishes its current stream
  // before taking another item. The shared queue assigns each UID exactly once.
  let next = 0;
  const work = async (client: Client) => {
    let selected: string | undefined;
    for (;;) {
      const entry = pending[next++];
      if (!entry) return;
      if (selected !== entry.source.mailbox) {
        const mailbox = await client.mailboxOpen(entry.source.mailbox, {
          readOnly: true,
        });
        if (String(mailbox.uidValidity) !== String(entry.source.uidValidity))
          throw new MailSampleError(
            "Source UIDVALIDITY changed. Use a new snapshot directory.",
          );
        selected = entry.source.mailbox;
      }
      const temporary = join(directory, "messages", `${entry.id}.partial`);
      try {
        const download = await client.download(
          String(entry.source.uid),
          undefined,
          {
            uid: true,
            binary: false,
            maxBytes: entry.size + 1,
            chunkSize: 4 * 1024 * 1024,
          },
        );
        if (!download.content)
          throw new MailSampleError("Source message missing.");
        const hash = createHash("sha256");
        let size = 0;
        const measure = new Transform({
          transform(chunk, _encoding, done) {
            size += chunk.length;
            if (size > entry.size)
              return done(new Error("Source size changed"));
            hash.update(chunk);
            done(null, chunk);
          },
        });
        await pipeline(
          download.content,
          measure,
          createWriteStream(temporary, { mode: 0o600 }),
        );
        if (size !== entry.size)
          throw new MailSampleError("Source size changed.");
        const handle = await open(temporary, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        const receipt = { id: entry.id, size, sha256: hash.digest("hex") };
        await rename(temporary, snapshotBody(directory, entry.id));
        await atomicJson(
          join(directory, "receipts", `${entry.id}.json`),
          receipt,
        );
        files.push(receipt);
        downloaded++;
      } catch {
        failures.push({
          id: entry.id,
          reason: "source-missing-changed-or-download-failed",
        });
      } finally {
        await rm(temporary, { force: true });
      }
      progress(files.length + failures.length, inventory.messages.length);
    }
  };
  // Await every connection even on failure, so no writer outlives the lock.
  const workers = await Promise.allSettled(
    [client, ...additionalClients].map(work),
  );
  for (const worker of workers)
    if (worker.status === "rejected") throw worker.reason;
  const complete =
    failures.length === 0 && files.length === inventory.messages.length;
  if (complete)
    await atomicJson(join(directory, "manifest.json"), {
      format: "oneapp-mail-snapshot",
      version: 1,
      snapshotId: inventory.snapshotId,
      inventorySha256,
      completedAt: new Date().toISOString(),
      files: files.sort((a, b) => a.id.localeCompare(b.id)),
    } satisfies SnapshotManifest);
  const report = {
    complete,
    downloaded,
    reused,
    messages: files.length,
    bytes: files.reduce((sum, entry) => sum + entry.size, 0),
    failures,
  };
  await atomicJson(join(directory, "export-report.json"), report);
  return report;
};
