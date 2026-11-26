import { expect, it } from "@effect/vitest";
import { Database } from "bun:sqlite";

it("backfills missing task statuses and preserves attachments with foreign keys enforced", async () => {
  using db = new Database(":memory:", { strict: true });
  const root = new URL("../../drizzle/", import.meta.url).pathname;
  const files = Array.from(
    new Bun.Glob("*/migration.sql").scanSync(root),
  ).sort();
  const upgrade = files.find((file) => file.includes("_task_status/"))!;
  for (const file of files.filter((file) => file < upgrade))
    db.exec(await Bun.file(root + file).text());

  db.exec(`
    PRAGMA foreign_keys = ON;
    INSERT INTO accounts (id, active, security_revision) VALUES ('owner', 1, '1');
    INSERT INTO items (account_id, id, kind, title, revision, created_at, updated_at)
    VALUES ('owner', 'legacy', 'task', 'Legacy', '1', 1, 2),
      ('owner', 'closed', 'task', 'Closed', '2', 3, 4),
      ('owner', 'new', 'task', 'New', '3', 6, 6);
    INSERT INTO tasks (account_id, item_id, description, status, priority, due_on)
    VALUES ('owner', 'legacy', 'Keep this description', NULL, 'high', '2028-02-29'),
      ('owner', 'closed', '', 'canceled', NULL, NULL);
    INSERT INTO task_attachments (account_id, task_id, id, name, media_type, size, created_at, state)
    VALUES ('owner', 'legacy', 'screenshot', 'test.png', 'image/png', 12, 5, 'ready');
  `);

  const attachments = db.query("SELECT * FROM task_attachments").all();
  const migration = await Bun.file(root + upgrade).text();
  db.transaction(() => db.exec(migration))();

  db.exec("INSERT INTO tasks (account_id, item_id) VALUES ('owner', 'new')");
  expect(
    db.query("SELECT item_id, status FROM tasks ORDER BY item_id").all(),
  ).toEqual([
    { item_id: "closed", status: "canceled" },
    { item_id: "legacy", status: "not-started" },
    { item_id: "new", status: "not-started" },
  ]);
  expect(
    db.query("SELECT * FROM tasks WHERE item_id = 'legacy'").get(),
  ).toMatchObject({
    description: "Keep this description",
    priority: "high",
    due_on: "2028-02-29",
  });
  expect(db.query("SELECT * FROM task_attachments").all()).toEqual(attachments);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(() => db.exec("UPDATE tasks SET status = NULL")).toThrow(/NOT NULL/u);
  expect(() => db.exec("UPDATE tasks SET status = 'unknown'")).toThrow(
    /CHECK/u,
  );

  db.exec("DELETE FROM items WHERE id = 'legacy'");
  expect(db.query("SELECT id FROM task_attachments").all()).toEqual([]);
});

it("keeps tasks and ready-tag runs created before assignment support", async () => {
  using db = new Database(":memory:", { strict: true });
  const root = new URL("../../drizzle/", import.meta.url).pathname;
  const files = Array.from(
    new Bun.Glob("*/migration.sql").scanSync(root),
  ).sort();
  const upgrade = files.find((file) => file.includes("_task_assignees/"))!;
  for (const file of files.filter((file) => file < upgrade))
    db.exec(await Bun.file(root + file).text());

  db.exec(`
    PRAGMA foreign_keys = ON;
    INSERT INTO accounts (id, active, security_revision) VALUES ('owner', 1, '1');
    INSERT INTO items (account_id, id, kind, title, revision, created_at, updated_at)
    VALUES ('owner', 'legacy', 'task', 'Legacy task', 'revision', 1, 2);
    INSERT INTO tasks (account_id, item_id, status) VALUES ('owner', 'legacy', 'in-progress');
    INSERT INTO task_runs (account_id, task_id, id, claim_revision, phase, started_at, updated_at)
    VALUES ('owner', 'legacy', 'run', 'revision', 'setup', 2, 2);
  `);
  const migration = await Bun.file(root + upgrade).text();
  db.transaction(() => db.exec(migration))();

  expect(db.query("SELECT status, author, assignee FROM tasks").get()).toEqual({
    status: "in-progress",
    author: null,
    assignee: null,
  });
  expect(
    db.query("SELECT assignment_request_revision FROM task_runs").get(),
  ).toEqual({
    assignment_request_revision: null,
  });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
