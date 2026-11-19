import type { D1Database } from "@cloudflare/workers-types";
import {
  normalizePersonEmail,
  type Person,
  type PersonMatch,
} from "../people-contract.ts";
import { ownerId } from "./auth.ts";

type PeopleDb = D1Database;
type PersonRow = {
  id: string;
  accountId: string | null;
  name: string;
  photo: string | null;
  revision: string;
};
const fields = "id, account_id AS accountId, name, photo, revision";

export const managedPersonAddresses = async (
  db: PeopleDb,
  mailbox?: string,
) => {
  const { results } = await db
    .prepare(
      `SELECT value FROM oneapp_auth_identifiers
      WHERE subject_id = ? AND namespace = 'email' AND active = 1 AND verified_at IS NOT NULL`,
    )
    .bind(ownerId)
    .all<{ value: string }>();
  return [
    ...new Set(
      [mailbox, ...results.map(({ value }) => value)].flatMap((email) =>
        email ? [normalizePersonEmail(email)] : [],
      ),
    ),
  ];
};

const findSelf = (db: PeopleDb) =>
  db
    .prepare(`SELECT ${fields} FROM people WHERE account_id = ?`)
    .bind(ownerId)
    .first<PersonRow>();

const ensureSelf = async (db: PeopleDb) => {
  const existing = await findSelf(db);
  if (existing) return existing;
  await db
    .prepare(
      "INSERT INTO people (id, account_id, revision) VALUES (?, ?, ?) ON CONFLICT(account_id) DO NOTHING",
    )
    .bind(crypto.randomUUID(), ownerId, crypto.randomUUID())
    .run();
  const created = await findSelf(db);
  if (!created) throw new Error("Could not create account profile");
  return created;
};

const summary = (row: PersonRow) => ({
  id: row.id,
  name: row.name,
  photo: row.photo,
  self: row.accountId === ownerId,
});

const withAddresses = (
  row: PersonRow,
  emails: string[],
  managed: string[],
): Person => {
  const managedAddresses = row.accountId === ownerId ? managed : [];
  return {
    ...summary(row),
    revision: row.revision,
    addresses: emails.filter((email) => !managedAddresses.includes(email)),
    managedAddresses,
  };
};

const describe = async (db: PeopleDb, row: PersonRow, managed: string[]) => {
  const { results } = await db
    .prepare(
      "SELECT email FROM person_addresses WHERE person_id = ? ORDER BY email",
    )
    .bind(row.id)
    .all<{ email: string }>();
  return withAddresses(
    row,
    results.map(({ email }) => email),
    managed,
  );
};

export const listPeople = async (db: PeopleDb, managed: string[]) => {
  await ensureSelf(db);
  const { results } = await db
    .prepare(
      `SELECT p.id, p.account_id AS accountId, p.name, p.photo, p.revision,
         json_group_array(a.email ORDER BY a.email) FILTER (WHERE a.email IS NOT NULL) AS emails
       FROM people p LEFT JOIN person_addresses a ON a.person_id = p.id
       GROUP BY p.id`,
    )
    .all<PersonRow & { emails: string }>();
  return results.map((row) =>
    withAddresses(row, JSON.parse(row.emails), managed),
  );
};

export const readProfile = async (
  db: PeopleDb,
  id: string,
  managed: string[],
) => {
  const row = await db
    .prepare(`SELECT ${fields} FROM people WHERE id = ?`)
    .bind(id)
    .first<PersonRow>();
  return row ? describe(db, row, managed) : null;
};

export const readSelfProfile = async (db: PeopleDb, managed: string[]) =>
  describe(db, await ensureSelf(db), managed);

export const matchPeople = async (
  db: PeopleDb,
  addresses: string[],
  managed: string[],
): Promise<PersonMatch[]> => {
  const emails = [
    ...new Set(addresses.map(normalizePersonEmail).filter(Boolean)),
  ];
  if (!emails.length) return [];
  const { results } = await db
    .prepare(
      `SELECT a.email, p.id, p.account_id AS accountId, p.name, p.photo, p.revision
     FROM person_addresses a JOIN people p ON p.id = a.person_id
     WHERE a.email IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(emails))
    .all<PersonRow & { email: string }>();
  const matches = new Map(results.map((row) => [row.email, summary(row)]));
  const selfEmails = emails.filter((email) => managed.includes(email));
  if (selfEmails.length) {
    const self = summary(await ensureSelf(db));
    for (const email of selfEmails) matches.set(email, self);
  }
  return [...matches].map(([email, person]) => ({ email, person }));
};

export const writeProfile = async (
  db: PeopleDb,
  id: string,
  currentRevision: string | undefined,
  name: string,
  addresses: string[],
  photo: string | null,
) => {
  const revision = crypto.randomUUID();
  const matchesRevision =
    "EXISTS (SELECT 1 FROM people WHERE id = ?1 AND revision = ?2)";
  const [saved] = await db.batch<{ id: string }>([
    currentRevision
      ? db
          .prepare(
            "UPDATE people SET name = ?, photo = ?, revision = ? WHERE id = ? AND revision = ? RETURNING id",
          )
          .bind(name, photo, revision, id, currentRevision)
      : db
          .prepare(
            "INSERT INTO people (id, name, photo, revision) VALUES (?, ?, ?, ?) RETURNING id",
          )
          .bind(id, name, photo, revision),
    db
      .prepare(
        `DELETE FROM person_addresses WHERE person_id = ?1 AND ${matchesRevision}`,
      )
      .bind(id, revision),
    db
      .prepare(
        `INSERT INTO person_addresses (email, person_id)
       SELECT value, ?1 FROM json_each(?3) WHERE ${matchesRevision}`,
      )
      .bind(id, revision, JSON.stringify(addresses)),
  ]);
  return saved?.results.length ? revision : null;
};
