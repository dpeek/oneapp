import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { expect, it } from "@effect/vitest";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  taskAttachmentApi,
  taskAttachmentObjectKey,
} from "../task-attachment-contract.ts";
import {
  collectTaskAttachments,
  createTaskAttachment,
  listTaskAttachments,
  purgeTaskAttachment,
  readTaskAttachment,
  removeTaskAttachment,
} from "./task-attachments-store.ts";
import { createTask, deleteTask, updateTask } from "./tasks-store.ts";

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
      run: async () => {
        const results = read();
        const meta = sqlite
          .query<{ changes: number }, []>("SELECT changes() AS changes")
          .get();
        return { results, meta };
      },
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
  const owner = { accountId: "owner", kind: "owner" } as const;
  const created = await createTask(
    db,
    owner,
    { id: task, title: "Screenshot task" },
    1,
  );
  const otherTask = await createTask(
    db,
    owner,
    { id: elsewhere, title: "Different task" },
    1,
  );
  await createTask(
    db,
    { ...owner, accountId: "other" },
    { id: task, title: "Different account" },
    1,
  );

  const blobs = new Map<string, ArrayBuffer>();
  let losePutResponse = false;
  let failDelete = false;
  const bucket = {
    put: async (key: string, bytes: ArrayBuffer) => {
      if (blobs.has(key)) return null;
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

  losePutResponse = false;
  const ready = await createTaskAttachment(
    db,
    bucket,
    "owner",
    task,
    metadata,
    bytes,
    3_600_005,
  );
  losePutResponse = true;
  await expect(
    createTaskAttachment(db, bucket, "owner", task, metadata, bytes, 3_600_006),
  ).rejects.toThrow("Lost upload response");
  expect(await deleteTask(db, "owner", task, created.task!.revision)).toBe(
    "deleted",
  );
  expect(
    await readTaskAttachment(db, bucket, "owner", task, ready!.id),
  ).toBeNull();
  expect(sqlite.query("SELECT * FROM task_attachments").all()).toEqual([]);
  failDelete = true;
  await expect(collectTaskAttachments(db, bucket, 3_600_007)).rejects.toThrow(
    "Blob store unavailable",
  );
  expect(blobs.size).toBe(2);
  failDelete = false;
  await collectTaskAttachments(db, bucket, 3_600_007);
  expect(blobs.has(taskAttachmentObjectKey("owner", task, ready!.id))).toBe(
    false,
  );
  expect(blobs.size).toBe(1);
  await collectTaskAttachments(db, bucket, 7_200_006);
  expect(blobs.size).toBe(0);
  expect(sqlite.query("SELECT * FROM deleted_task_attachments").all()).toEqual(
    [],
  );

  const retryId = crypto.randomUUID();
  const upload = (at: number) =>
    createTaskAttachment(
      db,
      bucket,
      "owner",
      elsewhere,
      metadata,
      bytes,
      at,
      retryId,
    );
  await expect(upload(7_200_007)).rejects.toThrow("Lost upload response");
  expect(await listTaskAttachments(db, "owner", elsewhere)).toEqual([]);
  losePutResponse = false;
  const retried = await Promise.all([upload(7_200_008), upload(7_200_009)]);
  expect(retried).toEqual([
    expect.objectContaining({ id: retryId, createdAt: 7_200_007 }),
    expect.objectContaining({ id: retryId, createdAt: 7_200_007 }),
  ]);
  expect(await upload(7_200_010)).toEqual(retried[0]);
  expect(await listTaskAttachments(db, "owner", elsewhere)).toEqual([
    retried[0],
  ]);
  expect(blobs.size).toBe(1);

  const inlineId = crypto.randomUUID();
  const inlineKey = taskAttachmentObjectKey("owner", elsewhere, inlineId);
  const reference = `![Screenshot](${taskAttachmentApi(elsewhere, inlineId)})`;
  await createTaskAttachment(
    db,
    bucket,
    "owner",
    elsewhere,
    metadata,
    bytes,
    7_300_000,
    inlineId,
    true,
  );
  expect(
    (await listTaskAttachments(db, "owner", elsewhere)).map(({ id }) => id),
  ).not.toContain(inlineId);
  expect(
    await readTaskAttachment(db, bucket, "owner", elsewhere, inlineId),
  ).not.toBeNull();

  let current = otherTask.task!;
  const save = async (description: string, now: number) => {
    const result = await updateTask(
      db,
      "owner",
      elsewhere,
      { ...current, description },
      now,
    );
    expect(result.changed).toBe(true);
    current = result.task!;
  };
  await save(`${reference}\n\n${reference}`, 7_300_001);
  expect(
    (await listTaskAttachments(db, "owner", elsewhere)).map(({ id }) => id),
  ).toContain(inlineId);
  await save(reference, 7_300_002);
  expect(
    await readTaskAttachment(db, bucket, "owner", elsewhere, inlineId),
  ).not.toBeNull();

  const conflict = await updateTask(
    db,
    "owner",
    elsewhere,
    {
      ...current,
      revision: otherTask.task!.revision,
      description: "",
    },
    7_300_003,
  );
  expect(conflict.changed).toBe(false);
  expect(
    await readTaskAttachment(db, bucket, "owner", elsewhere, inlineId),
  ).not.toBeNull();

  await save("", 7_300_004);
  expect(
    await readTaskAttachment(db, bucket, "owner", elsewhere, inlineId),
  ).toBeNull();
  expect(blobs.has(inlineKey)).toBe(true);
  await save(reference, 7_300_005);
  expect(
    await readTaskAttachment(db, bucket, "owner", elsewhere, inlineId),
  ).not.toBeNull();
  await save("", 7_300_006);
  await collectTaskAttachments(db, bucket, 10_900_006);
  expect(blobs.has(inlineKey)).toBe(false);
  const tooLate = await updateTask(
    db,
    "owner",
    elsewhere,
    { ...current, description: reference },
    10_900_007,
  );
  expect(tooLate.changed).toBe(false);
  expect(tooLate.task?.description).toBe("");
});
