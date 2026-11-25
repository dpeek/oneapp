import { D1, R2Bucket } from "@alchemy.run/cloudflare-runtime/core/bindings";
import { getPlatformProxy } from "@alchemy.run/cloudflare-runtime/core/platform-proxy";
import { applyMigrations, MigrationError } from "@alchemy.run/sql/Migrations";
import { BunServices } from "@effect/platform-bun";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { Effect } from "effect";
import { join } from "node:path";
import type { WorkerEnv } from "../alchemy.run.ts";
import { bucketBindings, type BucketBinding } from "./backup/cloudflare.ts";
import { objectFile, parallel, type Manifest } from "./backup/snapshot.ts";
import { localDirectory } from "./dev-local.ts";

export const localStageState = (stage: string) =>
  join(localDirectory, "state", "OneApp", stage);

const bucketResources = {
  INBOX_MESSAGES: "InboxMessages",
  SENT_MESSAGES: "SentMessages",
  PROFILE_PHOTOS: "ProfilePhotos",
  VAULT_FILES: "VaultFiles",
  FILE_UPLOADS: "FileUploads",
} as const satisfies Record<BucketBinding, string>;

// Import only durable application tables, in foreign-key order. The target
// account and every credential, session and delivery queue come from local
// provisioning. Optional tables support branches with additional migrations.
const dataTables = [
  "mailboxes",
  "mailbox_addresses",
  "mail_domain_routes",
  "mail_index_messages",
  "mail_index_keys",
  "mail_index_scans",
  "mail_sender_rules",
  "mail_sender_avatars",
  "mail_imports",
  "mail_import_completions",
  "mail_import_runs",
  "people",
  "person_addresses",
  "company_domains",
  "contact_deletions",
  "links",
  "personal_vaults",
  "personal_vault_folders",
  "personal_vault_logins",
  "personal_vault_deleted_items",
  "personal_vault_imports",
  "personal_vault_attachments",
  "personal_vault_attachment_cleanup",
  "calendars",
  "calendar_events",
  "calendar_moved_uids",
  "items",
  "tasks",
  "task_attachments",
  "files",
  "tags",
  "item_tags",
] as const;

export const migrateSnapshot = async (db: Database) => {
  db.exec("PRAGMA foreign_keys = ON");
  const attempt = <A>(run: () => A) =>
    Effect.try({
      try: run,
      catch: (cause) =>
        new MigrationError({
          message: "Could not migrate the restored database.",
          cause,
        }),
    });
  await Effect.runPromise(
    applyMigrations({
      resolved: {
        dir: join(import.meta.dir, "..", "apps", "web", "drizzle"),
        table: "__alchemy_migrations",
      },
      executor: {
        dialect: "sqlite",
        query: (sql, params) =>
          attempt(() =>
            db
              .query<Record<string, unknown>, SQLQueryBindings[]>(sql)
              .all(...((params ?? []) as SQLQueryBindings[])),
          ),
        batch: (statements) =>
          attempt(() => {
            db.transaction(() => {
              for (const sql of statements) db.exec(sql);
            })();
          }),
      },
    }).pipe(Effect.provide(BunServices.layer)),
  );
  if (db.query("PRAGMA foreign_key_check").get())
    throw new Error(
      "Branch migrations produced invalid foreign keys in the snapshot.",
    );
};

export const snapshotOwner = (db: Database): string => {
  const row = db
    .query<{ value: string }, []>(
      "SELECT i.value FROM oneapp_auth_identifiers i JOIN accounts a ON a.id = i.subject_id " +
        "WHERE a.id = 'owner' AND a.active = 1 AND i.namespace = 'email' AND i.active = 1",
    )
    .get();
  const accounts = db
    .query<{ count: number }, []>("SELECT count(*) AS count FROM accounts")
    .get();
  if (accounts?.count !== 1 || !row?.value)
    throw new Error(
      "The snapshot must contain one active OneApp owner with an email address.",
    );
  return row.value;
};

const localId = async (stage: string, resource: string, attr: string) => {
  const state = await Bun.file(
    join(localStageState(stage), resource + ".json"),
  ).json();
  const id: unknown = state.attr?.[attr];
  if (
    state.providerMode !== "local" ||
    typeof id !== "string" ||
    !id.startsWith("dev:")
  )
    throw new Error("The snapshot target must have local bindings.");
  return id;
};

const quote = (identifier: string) =>
  '"' + identifier.replaceAll('"', '""') + '"';

const copyDatabase = async (source: Database, target: WorkerEnv["DB"]) => {
  const hasTable = source.query<{ name: string }, [string]>(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
  );
  let copied = 0;
  for (const table of dataTables) {
    if (!hasTable.get(table)) continue;
    const name = quote(table);
    const read = source.query<Record<string, SQLQueryBindings>, []>(
      "SELECT * FROM " + name,
    );
    const columns = read.columnNames;
    const insert =
      "INSERT INTO " +
      name +
      " (" +
      columns.map(quote).join(", ") +
      ") VALUES ";
    const placeholders = "(" + columns.map(() => "?").join(", ") + ")";
    const batchSize = Math.max(1, Math.floor(100 / columns.length));
    let batch: Array<SQLQueryBindings | undefined> = [];
    const flush = async () => {
      const rows = batch.length / columns.length;
      const sql = insert + Array<string>(rows).fill(placeholders).join(", ");
      await target
        .prepare(sql)
        .bind(...batch)
        .run();
      batch = [];
    };
    let count = 0;
    for (const row of read.iterate()) {
      batch.push(...columns.map((column) => row[column]));
      count++;
      if (count % batchSize === 0) await flush();
    }
    if (batch.length) await flush();
    const restored = await target
      .prepare("SELECT count(*) AS count FROM " + name)
      .first<number>("count");
    if (restored !== count)
      throw new Error("Local row count differs for " + table + ".");
    copied += count;
  }
  console.log(
    "Restored " + copied + " application rows with local credentials.",
  );
};

const objectMetadata = (
  entry: Manifest["objects"][BucketBinding][number],
  bucket: BucketBinding,
) => {
  const http = entry.http_metadata;
  const uploaded = Date.parse(entry.last_modified);
  const mail = bucket === "INBOX_MESSAGES" || bucket === "SENT_MESSAGES";
  return {
    sha256: entry.sha256,
    httpMetadata: {
      contentType: http?.contentType ?? undefined,
      contentLanguage: http?.contentLanguage ?? undefined,
      contentDisposition: http?.contentDisposition ?? undefined,
      contentEncoding: http?.contentEncoding ?? undefined,
      cacheControl: http?.cacheControl ?? undefined,
      cacheExpiry: http?.cacheExpiry ? new Date(http.cacheExpiry) : undefined,
    },
    customMetadata: {
      // Re-uploading resets R2's uploaded timestamp. Legacy raw mail uses it
      // when there is no explicit original timestamp.
      ...(mail && Number.isFinite(uploaded)
        ? { originalTimestamp: String(uploaded) }
        : {}),
      ...entry.custom_metadata,
    },
  };
};

export const restoreBindings = async (
  stage: string,
  directory: string,
  manifest: Manifest,
  database: Database,
) => {
  const [databaseId, ...bucketIds] = await Promise.all([
    localId(stage, "Database", "databaseId"),
    ...bucketBindings.map((bucket) =>
      localId(stage, bucketResources[bucket], "bucketName"),
    ),
  ]);
  const proxy = await getPlatformProxy<Pick<WorkerEnv, "DB" | BucketBinding>>({
    name: "oneapp-restore-" + stage,
    compatibilityDate: "2026-11-01",
    persist: { directory: join(localDirectory, "local") },
    bindings: [
      D1.local({ binding: "DB", id: databaseId }),
      ...bucketBindings.map((binding, index) =>
        R2Bucket.local({ binding, id: bucketIds[index]! }),
      ),
    ],
  });
  try {
    for (const bucket of bucketBindings) {
      const entries = manifest.objects[bucket];
      await parallel(
        entries,
        async (entry, index) => {
          const body = await Bun.file(
            objectFile(directory, bucket, index),
          ).arrayBuffer();
          const result = await proxy.env[bucket].put(
            entry.key,
            body,
            objectMetadata(entry, bucket),
          );
          if (!result || result.size !== entry.size)
            throw new Error("Local R2 verification failed for " + bucket + ".");
        },
        3,
      );
      console.log(
        "Loaded " + entries.length + " " + bucket + " objects into local R2.",
      );
    }

    await copyDatabase(database, proxy.env.DB);
    const foreignKey = await proxy.env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).first();
    if (foreignKey)
      throw new Error("The local database contains broken foreign keys.");
  } finally {
    await proxy.dispose();
  }
};
