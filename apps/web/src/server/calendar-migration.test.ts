import { expect, it } from "@effect/vitest";
import { Database } from "bun:sqlite";

it("moves existing events, import tombstones and reminders into the default calendar", async () => {
  using db = new Database(":memory:");
  const root = new URL("../../drizzle/", import.meta.url).pathname;
  const files = Array.from(
    new Bun.Glob("*/migration.sql").scanSync(root),
  ).sort();
  const upgrade = files.find((file) => file.includes("_named_calendars/"))!;
  for (const file of files.filter((file) => file < upgrade))
    db.exec(await Bun.file(root + file).text());

  db.exec(`
    PRAGMA foreign_keys = ON;
    INSERT INTO accounts (id, active, security_revision) VALUES ('owner', 1, '1'), ('other', 1, '1');
    INSERT INTO mailboxes (id, owner_account_id, name) VALUES ('mail', 'owner', 'Mail');
    INSERT INTO push_subscriptions
      (id, account_id, mailbox_id, session_id, security_revision, endpoint, p256dh, auth, created_at)
      VALUES ('device', 'owner', 'mail', 'session', '1', 'endpoint', 'key', 'auth', 100);
    INSERT INTO calendar_events
      (id, account_id, uid, ics, revision, remind_at, reminder_ends_at, deleted)
      VALUES ('event', 'owner', 'original-uid', 'original-ics', 'original-revision', 100, 1000, 0),
      ('tombstone', 'owner', 'deleted-uid', '', 'first-revision', NULL, NULL, 1);
    INSERT INTO calendar_push_outbox
      (event_id, subscription_id, remind_at, expires_at, next_attempt_at, attempts, lease)
      VALUES ('event', 'device', 100, 1000, 200, 1, 'in-flight');
  `);
  const migration = await Bun.file(root + upgrade).text();
  db.transaction(() => db.exec(migration))();

  expect(
    db.query("SELECT id, name FROM calendars WHERE account_id = 'owner'").all(),
  ).toEqual([{ id: "default", name: "Personal" }]);
  expect(
    db
      .query(
        "SELECT id, calendar_id, uid, ics, revision, deleted FROM calendar_events ORDER BY id",
      )
      .all(),
  ).toEqual([
    {
      id: "event",
      calendar_id: "default",
      uid: "original-uid",
      ics: "original-ics",
      revision: "original-revision",
      deleted: 0,
    },
    {
      id: "tombstone",
      calendar_id: "default",
      uid: "deleted-uid",
      ics: "",
      revision: "first-revision",
      deleted: 1,
    },
  ]);
  expect(db.query("SELECT * FROM calendar_push_outbox").all()).toEqual([
    {
      event_id: "event",
      subscription_id: "device",
      remind_at: 100,
      expires_at: 1000,
      next_attempt_at: 200,
      attempts: 1,
      lease: "in-flight",
      completed_at: null,
    },
  ]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.exec(
    "INSERT INTO calendars (account_id, id, name, name_key) VALUES ('other', 'private', 'Private', 'private')",
  );
  expect(() =>
    db.exec(
      "UPDATE calendar_events SET calendar_id = 'private' WHERE id = 'event'",
    ),
  ).toThrow(/FOREIGN KEY/u);
});
