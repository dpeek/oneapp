import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { expect, it } from "@effect/vitest";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { taskAttachmentObjectKey } from "../task-attachment-contract.ts";
import {
  collectTaskAttachments,
  createTaskAttachment,
  listTaskAttachments,
  purgeTaskAttachment,
  readTaskAttachment,
  removeTaskAttachment,
} from "./task-attachments-store.ts";
import { createTask } from "./tasks-store.ts";

it("keeps screenshots private by task and retries cleanup after revoking access", async () => {
  using sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const path = new URL("../../drizzle/", import.meta.url).pathname;
  for (const file of Array.from(
    new Bun.Glob("*/migration.sql").scanSync(path),
  ).sort())
    sqlite.exec(await Bun.file(path + file).text());
  const prepare = (sql: string, parameters: SQLQueryBindings[] = []) => {
    const read = () => sqlite.query(sql).all(...parameters);
    return {
      bind: (...parameters: SQLQueryBindings[]) => prepare(sql, parameters),
      first: async () => read()[0] ?? null,
      all: async () => ({ results: read() }),
      run: async () => ({ results: read() }),
    };
  };
  const db = {
    prepare,
    batch: (statements: ReturnType<typeof prepare>[]) =>
      Promise.all(statements.map((statement) => statement.run())),
  } as unknown as D1Database;
  sqlite.exec(
    "INSERT INTO accounts (id, active, security_revision) VALUES ('owner', 1, '1'), ('other', 1, '1')",
  );
  const task = crypto.randomUUID();
  const elsewhere = crypto.randomUUID();
  await createTask(db, "owner", { id: task, title: "Screenshot task" }, 1);
  await createTask(db, "owner", { id: elsewhere, title: "Different task" }, 1);
  await createTask(db, "other", { id: task, title: "Different account" }, 1);

  const blobs = new Map<string, ArrayBuffer>();
  let losePutResponse = false;
  let failDelete = false;
  const bucket = {
    put: async (key: string, bytes: ArrayBuffer) => {
      blobs.set(key, bytes);
      if (losePutResponse) throw new Error("Lost upload response");
      return { key };
    },
    get: async (key: string) => blobs.get(key) ?? null,
    delete: async (keys: string | string[]) => {
      if (failDelete) throw new Error("Blob store unavailable");
      for (const key of [keys].flat()) blobs.delete(key);
    },
  } as unknown as R2Bucket;
  const bytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10).buffer;
  const metadata = { name: "screenshot.png", mediaType: "image/png" } as const;
  const saved = await createTaskAttachment(
    db,
    bucket,
    "owner",
    task,
    metadata,
    bytes,
    2,
  );
  expect(saved).toMatchObject({
    ...metadata,
    size: bytes.byteLength,
    createdAt: 2,
  });
  const id = saved!.id;
  const key = taskAttachmentObjectKey("owner", task, id);
  expect(await listTaskAttachments(db, "owner", task)).toEqual([saved]);
  expect(await readTaskAttachment(db, bucket, "owner", task, id)).toMatchObject(
    { attachment: saved },
  );
  expect(
    await readTaskAttachment(db, bucket, "owner", elsewhere, id),
  ).toBeNull();
  expect(await readTaskAttachment(db, bucket, "other", task, id)).toBeNull();
  expect(await removeTaskAttachment(db, "other", task, id)).toBeNull();
  expect(await removeTaskAttachment(db, "owner", elsewhere, id)).toBeNull();
  expect(await removeTaskAttachment(db, "owner", task, id)).toEqual({ id });
  failDelete = true;
  await expect(
    purgeTaskAttachment(db, bucket, "owner", task, id),
  ).rejects.toThrow("Blob store unavailable");
  expect(blobs.has(key)).toBe(true);
  expect(await readTaskAttachment(db, bucket, "owner", task, id)).toBeNull();
  expect(await listTaskAttachments(db, "owner", task)).toEqual([]);

  losePutResponse = true;
  await expect(
    createTaskAttachment(db, bucket, "owner", task, metadata, bytes, 3),
  ).rejects.toThrow("Lost upload response");
  const pending = sqlite
    .query<{ id: string }, []>(
      "SELECT id FROM task_attachments WHERE state = 'pending'",
    )
    .get()!;
  expect(
    await readTaskAttachment(db, bucket, "owner", task, pending.id),
  ).toBeNull();
  failDelete = false;
  await collectTaskAttachments(db, bucket, 4);
  expect(blobs.has(key)).toBe(false);
  expect(blobs.has(taskAttachmentObjectKey("owner", task, pending.id))).toBe(
    true,
  );
  await collectTaskAttachments(db, bucket, 3_600_004);
  expect(blobs.size).toBe(0);
  expect(sqlite.query("SELECT * FROM task_attachments").all()).toEqual([]);
});
