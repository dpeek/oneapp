import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Schema } from "effect";
import { bucketBindings, openSource } from "./backup/cloudflare.ts";
import {
  defaultBackupDirectory,
  encrypt,
  makeObjectDirectories,
  Manifest,
  objectFile,
  parallel,
  publishDirectory,
  restoreDatabase,
  restoreSnapshot,
  verifyReferences,
} from "./backup/snapshot.ts";

const usage = [
  "bun run backup:capture --worker <script-name> --recipient <age-public-key> [--out <backup-directory>]",
  "bun run backup:restore --snapshot <snapshot-directory> --identity <age-key-file> --out <new-directory>",
].join("\n");

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    help: { type: "boolean" },
    worker: { type: "string" },
    recipient: { type: "string" },
    out: { type: "string" },
    snapshot: { type: "string" },
    identity: { type: "string" },
  },
});

if (values.help) {
  console.log(usage);
  process.exit(0);
}

const captureDatabase = async (
  source: Awaited<ReturnType<typeof openSource>>,
  recipient: string,
  destination: string,
  createdAt: string,
) => {
  const temporary = await mkdtemp(join(tmpdir(), "oneapp-d1-"));
  try {
    const sql = join(temporary, "database.sql");
    console.log(
      "Exporting D1. Requests to the production database may pause during export.",
    );
    const { body, bookmark } = await source.exportDatabase();
    await Bun.write(sql, body);
    await chmod(sql, 0o600);
    const references = await restoreDatabase(
      sql,
      join(temporary, "database.sqlite"),
      createdAt,
    );
    const file = await encrypt(recipient, destination, Bun.file(sql).stream());
    return { database: { ...file, bookmark }, references };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};

try {
  if (!Bun.which("age") || !Bun.which("sqlite3"))
    throw new Error("Install age and sqlite3 before running backups.");

  if (positionals[0] === "capture" && positionals.length === 1) {
    const { worker, recipient } = values;
    if (!worker || !recipient || !/^age1[a-z0-9]{58}$/u.test(recipient))
      throw new Error(
        "Capture requires --worker and an age public key in --recipient.",
      );
    const source = await openSource(worker);
    const createdAt = new Date().toISOString();
    const stamp = createdAt.replaceAll(":", "-");
    const name = "oneapp-" + stamp + "-" + crypto.randomUUID().slice(0, 8);
    const destination = join(
      resolve(values.out ?? defaultBackupDirectory),
      name,
    );

    await publishDirectory(destination, async (temporary) => {
      await makeObjectDirectories(temporary);
      const { database, references } = await captureDatabase(
        source,
        recipient,
        join(temporary, "database.sql.age"),
        createdAt,
      );
      const objects: {
        -readonly [K in keyof Manifest["objects"]]: Manifest["objects"][K];
      } = {
        INBOX_MESSAGES: [],
        SENT_MESSAGES: [],
        PROFILE_PHOTOS: [],
        VAULT_FILES: [],
        FILE_UPLOADS: [],
      };
      for (const bucket of bucketBindings) {
        const entries = await Array.fromAsync(source.list(bucket));
        const captured: Array<Manifest["objects"][typeof bucket][number]> = [];
        console.log("Capturing " + entries.length + " " + bucket + " objects.");
        await parallel(entries, async (entry, index) => {
          const path = objectFile(temporary, bucket, index) + ".age";
          const file = await encrypt(
            recipient,
            path,
            await source.get(bucket, entry),
          );
          if (file.size !== entry.size)
            throw new Error(
              "An object in " +
                bucket +
                " was truncated or changed during capture.",
            );
          captured[index] = {
            key: entry.key,
            etag: entry.etag,
            last_modified: entry.last_modified,
            ...(entry.http_metadata
              ? { http_metadata: entry.http_metadata }
              : {}),
            ...(entry.custom_metadata
              ? { custom_metadata: entry.custom_metadata }
              : {}),
            ...file,
          };
        });
        objects[bucket] = captured;
      }

      const manifest = Schema.decodeUnknownSync(Manifest)({
        version: 1,
        createdAt,
        completedAt: new Date().toISOString(),
        source: {
          account: source.account,
          worker: source.worker,
          database: source.database,
          buckets: source.buckets,
        },
        database,
        objects,
      });
      verifyReferences(manifest, references);
      await encrypt(
        recipient,
        join(temporary, "manifest.json.age"),
        new Blob([JSON.stringify(manifest, null, 2) + "\n"]).stream(),
      );
    });
    console.log("Encrypted backup saved to " + destination);
  } else if (positionals[0] === "restore" && positionals.length === 1) {
    const { snapshot, identity, out } = values;
    if (!snapshot || !identity || !out)
      throw new Error("Restore requires --snapshot, --identity, and --out.");
    const source = resolve(snapshot);
    const destination = resolve(out);

    await restoreSnapshot(source, identity, destination);
    console.log("Verified restore saved to " + destination);
  } else {
    throw new Error(usage);
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Backup operation failed.",
  );
  process.exitCode = 1;
}
