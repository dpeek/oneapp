import { Database } from "bun:sqlite";
import { chmod, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Effect, Schema } from "effect";
import { bucketBindings, type BucketBinding } from "./cloudflare.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const File = Schema.Struct({
  size: Count,
  sha256: Digest,
});
const ObjectEntry = Schema.Struct({
  ...File.fields,
  key: Schema.NonEmptyString,
  etag: Schema.NonEmptyString,
  last_modified: Schema.NonEmptyString,
  custom_metadata: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String),
  ),
  http_metadata: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  ),
});
const BucketSource = Schema.Struct({
  name: Schema.NonEmptyString,
  jurisdiction: Schema.NonEmptyString,
});
const bucketFields = <S extends Schema.Constraint>(schema: S) => ({
  INBOX_MESSAGES: schema,
  SENT_MESSAGES: schema,
  PROFILE_PHOTOS: schema,
  VAULT_FILES: schema,
});

export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  createdAt: Schema.NonEmptyString,
  completedAt: Schema.NonEmptyString,
  source: Schema.Struct({
    account: Schema.NonEmptyString,
    worker: Schema.NonEmptyString,
    database: Schema.NonEmptyString,
    buckets: Schema.Struct({
      ...bucketFields(BucketSource),
      FILE_UPLOADS: Schema.optionalKey(BucketSource),
    }),
  }),
  database: Schema.Struct({ ...File.fields, bookmark: Schema.NonEmptyString }),
  objects: Schema.Struct({
    ...bucketFields(Schema.Array(ObjectEntry)),
    FILE_UPLOADS: Schema.Array(ObjectEntry).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed([])),
    ),
  }),
});
export type Manifest = typeof Manifest.Type;
export const defaultBackupDirectory = join(
  homedir(),
  ".local",
  "share",
  "oneapp",
  "backups",
);

export const objectFile = (
  root: string,
  bucket: BucketBinding,
  index: number,
) => join(root, "objects", bucket, String(index));

export const fileDigest = async (source: ReadableStream<Uint8Array>) => {
  const hash = new Bun.CryptoHasher("sha256");
  let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest("hex") };
};

const run = async (args: string[], stdin?: ReadableStream<Uint8Array>) => {
  const child = Bun.spawn(args, {
    stdin: stdin ?? "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await child.exited) !== 0) throw new Error(args[0] + " failed.");
};

export const encrypt = async (
  recipient: string,
  output: string,
  source: ReadableStream<Uint8Array>,
) => {
  const hash = new Bun.CryptoHasher("sha256");
  let size = 0;
  const stream = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        hash.update(chunk);
        controller.enqueue(chunk);
      },
    }),
  );
  await run(["age", "-r", recipient, "-o", output], stream);
  await chmod(output, 0o600);
  return { size, sha256: hash.digest("hex") };
};

export const decrypt = async (
  identity: string,
  source: string,
  output: string,
) => {
  await run(["age", "-d", "-i", identity, "-o", output, source]);
  await chmod(output, 0o600);
};

export const makeObjectDirectories = async (root: string) => {
  await Promise.all(
    bucketBindings.map((bucket) =>
      mkdir(dirname(objectFile(root, bucket, 0)), {
        recursive: true,
        mode: 0o700,
      }),
    ),
  );
};

export const parallel = async <A>(
  items: readonly A[],
  task: (item: A, index: number) => Promise<void>,
  concurrency = 6,
) => {
  let next = 0;
  let failed = false;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          await task(items[index]!, index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    },
  );
  const outcomes = await Promise.allSettled(workers);
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure) throw failure.reason;
};

const requireAbsent = async (path: string) => {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("The destination already exists.");
};

export const publishDirectory = async <A>(
  destination: string,
  populate: (temporary: string) => Promise<A>,
) => {
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await requireAbsent(destination);
  const temporary = await mkdtemp(
    join(parent, "." + basename(destination) + "-"),
  );
  try {
    const result = await populate(temporary);
    await requireAbsent(destination);
    await rename(temporary, destination);
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};

const references: ReadonlyArray<readonly [BucketBinding, string]> = [
  [
    "INBOX_MESSAGES",
    "SELECT mailbox_id, id FROM mail_index_messages WHERE folder = 'inbox' AND deleted IN (0, 1)",
  ],
  [
    "SENT_MESSAGES",
    "SELECT mailbox_id, id FROM mail_index_messages WHERE folder = 'sent' AND deleted IN (0, 1)",
  ],
  [
    "PROFILE_PHOTOS",
    "SELECT photo AS id FROM people WHERE photo IS NOT NULL UNION SELECT photo FROM contact_deletions WHERE photo IS NOT NULL AND expires_at > ?",
  ],
  [
    "VAULT_FILES",
    "SELECT id FROM personal_vault_attachments WHERE ready_at IS NOT NULL",
  ],
];

export const restoreDatabase = async (
  sql: string,
  sqlite: string,
  createdAt: string,
) => {
  await run(
    ["sqlite3", "-safe", "-bail", "-init", "/dev/null", sqlite],
    Bun.file(sql).stream(),
  );
  await chmod(sqlite, 0o600);
  using db = new Database(sqlite, { readonly: true });
  const integrity = db
    .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
    .all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
    throw new Error("The restored SQLite database failed its integrity check.");
  if (db.query("PRAGMA foreign_key_check").get())
    throw new Error(
      "The restored SQLite database contains broken foreign keys.",
    );

  const at = Date.parse(createdAt);
  if (!Number.isFinite(at)) throw new Error("Invalid snapshot capture time.");
  const result = references.map(([bucket, query]) => {
    const rows = db
      .query<{ id: string; mailbox_id?: string }, [number] | []>(query)
      .all(...(bucket === "PROFILE_PHOTOS" ? ([at] as const) : []));
    const keys = rows.map(({ id, mailbox_id: mailbox }) =>
      mailbox && mailbox !== "personal"
        ? "mailboxes/" + mailbox + "/" + id
        : id,
    );
    return { bucket, keys };
  });
  const files = db
    .query(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'files'",
    )
    .get();
  if (files) {
    const rows = db
      .query<{ key: string }, []>(
        "SELECT account_id || '/' || item_id AS key FROM files",
      )
      .all();
    result.push({ bucket: "FILE_UPLOADS", keys: rows.map(({ key }) => key) });
  }
  return result;
};

export const verifyReferences = (
  manifest: Manifest,
  databaseReferences: Awaited<ReturnType<typeof restoreDatabase>>,
) => {
  for (const { bucket, keys: expected } of databaseReferences) {
    const keys = new Set(manifest.objects[bucket].map(({ key }) => key));
    if (keys.size !== manifest.objects[bucket].length)
      throw new Error("Duplicate object keys in " + bucket + ".");
    const missing = expected.filter((key) => !keys.has(key)).length;
    if (missing)
      throw new Error(
        bucket + " is missing " + missing + " referenced object(s).",
      );
  }
};

const checkFile = async (path: string, expected: typeof File.Type) => {
  const actual = await fileDigest(Bun.file(path).stream());
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256)
    throw new Error("A restored file failed checksum validation.");
};

export const restoreSnapshot = async (
  source: string,
  identity: string,
  destination: string,
) => {
  return publishDirectory(destination, async (temporary) => {
    const json = join(temporary, "manifest.json");
    await decrypt(identity, join(source, "manifest.json.age"), json);
    const manifest = Schema.decodeUnknownSync(Manifest)(
      await Bun.file(json).json(),
    );
    await makeObjectDirectories(temporary);
    const sql = join(temporary, "database.sql");
    await decrypt(identity, join(source, "database.sql.age"), sql);
    await checkFile(sql, manifest.database);
    for (const bucket of bucketBindings) {
      await parallel(manifest.objects[bucket], async (entry, index) => {
        const output = objectFile(temporary, bucket, index);
        await decrypt(
          identity,
          objectFile(source, bucket, index) + ".age",
          output,
        );
        await checkFile(output, entry);
      });
      console.log(
        "Verified " +
          manifest.objects[bucket].length +
          " " +
          bucket +
          " objects.",
      );
    }
    const references = await restoreDatabase(
      sql,
      join(temporary, "database.sqlite"),
      manifest.createdAt,
    );
    verifyReferences(manifest, references);
    return manifest;
  });
};
