import { expect, it } from "@effect/vitest";
import { Database } from "bun:sqlite";

it("removes company email links and undo addresses while preserving contact details and sender rules", async () => {
  using db = new Database(":memory:");
  const root = new URL("../../drizzle/", import.meta.url).pathname;
  const files = Array.from(
    new Bun.Glob("*/migration.sql").scanSync(root),
  ).sort();
  const upgrade = files.find((file) =>
    file.includes("_remove_company_addresses/"),
  )!;
  for (const file of files.filter((file) => file < upgrade))
    db.exec(await Bun.file(root + file).text());

  db.exec(`
    PRAGMA foreign_keys = ON;
    INSERT INTO accounts (id, active, security_revision) VALUES ('owner', 1, '1');
    INSERT INTO mailboxes (id, owner_account_id, name) VALUES ('mail', 'owner', 'Mail');
    INSERT INTO people (id, name, kind, revision, photo, avatar_style) VALUES
      ('alice', 'Alice', 'person', '1', NULL, NULL),
      ('cedar', 'Cedar', 'company', '2', 'photo', 'fit'),
      ('pine', 'Pine', 'company', '3', NULL, NULL);
    INSERT INTO person_addresses (email, person_id) VALUES
      ('alice@cedar.example', 'alice'),
      ('sales@cedar.example', 'cedar'),
      ('support@example.net', 'pine');
    INSERT INTO company_domains (domain, company_id) VALUES ('cedar.example', 'cedar');
    INSERT INTO mail_sender_rules (mailbox_id, address, priority) VALUES
      ('mail', 'sales@cedar.example', 'signal'), ('mail', 'support@example.net', 'noise');
    INSERT INTO contact_deletions (id, receipt, name, kind, revision, addresses, domains, expires_at) VALUES
      ('bob', 'bob-receipt', 'Bob', 'person', '4', '["bob@example.net"]', '[]', 100),
      ('fir', 'fir-receipt', 'Fir', 'company', '5', '["fir@example.net"]', '[]', 100);
  `);
  const preserved = ["people", "company_domains", "mail_sender_rules"].map(
    (table) => db.query(`SELECT * FROM ${table} ORDER BY 1, 2`),
  );
  const before = preserved.map((query) => query.all());
  const migration = await Bun.file(root + upgrade).text();
  db.transaction(() => db.exec(migration))();

  expect(preserved.map((query) => query.all())).toEqual(before);
  expect(db.query("SELECT * FROM person_addresses").all()).toEqual([
    { email: "alice@cedar.example", person_id: "alice" },
  ]);
  expect(
    db.query("SELECT id, addresses FROM contact_deletions ORDER BY id").all(),
  ).toEqual([
    { id: "bob", addresses: '["bob@example.net"]' },
    { id: "fir", addresses: "[]" },
  ]);
});
