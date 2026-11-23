import type { D1Database } from "@cloudflare/workers-types";
import {
  normalizePersonEmail,
  type Person,
  type PersonMatch,
} from "../people-contract.ts";
import { senderIconDomain } from "./mail-sender.ts";
import { companyForHostname } from "../company-domains.ts";
import { ownerId } from "./auth.ts";

type PeopleDb = D1Database;
type PersonRow = {
  id: string;
  accountId: string | null;
  name: string;
  kind: "person" | "company";
  domains: string;
  iconEmail: string | null;
  photo: string | null;
  revision: string;
};
const fields = `p.id, p.account_id AS accountId, p.name, p.photo, p.revision, p.kind,
  (SELECT json_group_array(domain ORDER BY position) FROM company_domains WHERE company_id = p.id) AS domains,
  (SELECT email FROM person_addresses WHERE person_id = p.id ORDER BY email LIMIT 1) AS iconEmail`;

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
  const identities = await db
    .prepare(
      "SELECT address FROM mailbox_addresses a JOIN mailboxes b ON b.id = a.mailbox_id WHERE b.owner_account_id = ?",
    )
    .bind(ownerId)
    .all<{ address: string }>();
  return [
    ...new Set(
      [
        mailbox,
        ...identities.results.map(({ address }) => address),
        ...results.map(({ value }) => value),
      ].flatMap((email) => (email ? [normalizePersonEmail(email)] : [])),
    ),
  ];
};

const findSelf = (db: PeopleDb) =>
  db
    .prepare(`SELECT ${fields} FROM people p WHERE p.account_id = ?`)
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
  ...(row.kind === "company"
    ? {
        kind: row.kind,
        domains: JSON.parse(row.domains) as string[],
        iconDomain:
          (JSON.parse(row.domains) as string[])[0] ??
          (row.iconEmail ? senderIconDomain(row.iconEmail) : null),
      }
    : {}),
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
      `SELECT ${fields},
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
    .prepare(`SELECT ${fields} FROM people p WHERE p.id = ?`)
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
      `SELECT a.email, ${fields}
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
  kind: "person" | "company" = "person",
  domains: string[] = [],
  noise?: { mailboxId: string; on: string[]; off: string[] },
) => {
  const revision = crypto.randomUUID();
  const matchesRevision =
    "EXISTS (SELECT 1 FROM people WHERE id = ?1 AND revision = ?2)";
  const [saved] = await db.batch<{ id: string }>([
    currentRevision
      ? db
          .prepare(
            "UPDATE people SET name = ?, photo = ?, revision = ?, kind = ? WHERE id = ? AND revision = ? RETURNING id",
          )
          .bind(name, photo, revision, kind, id, currentRevision)
      : db
          .prepare(
            "INSERT INTO people (id, name, photo, revision, kind) VALUES (?, ?, ?, ?, ?) RETURNING id",
          )
          .bind(id, name, photo, revision, kind),
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
    db
      .prepare(
        `DELETE FROM company_domains WHERE company_id = ?1 AND ${matchesRevision}`,
      )
      .bind(id, revision),
    db
      .prepare(
        `INSERT INTO company_domains (domain, company_id, position) SELECT value, ?1, key FROM json_each(?3) WHERE ${matchesRevision}`,
      )
      .bind(id, revision, JSON.stringify(domains)),
    ...(noise
      ? [
          db
            .prepare(
              `DELETE FROM mail_sender_rules WHERE mailbox_id = ?4 AND priority = 'noise'
               AND address IN (SELECT value FROM json_each(?3)) AND ${matchesRevision}`,
            )
            .bind(id, revision, JSON.stringify(noise.off), noise.mailboxId),
          db
            .prepare(
              `INSERT INTO mail_sender_rules (mailbox_id, address, priority)
               SELECT ?4, value, 'noise' FROM json_each(?3) WHERE ${matchesRevision}
               ON CONFLICT(mailbox_id, address) DO UPDATE SET priority = excluded.priority`,
            )
            .bind(id, revision, JSON.stringify(noise.on), noise.mailboxId),
        ]
      : []),
  ]);
  return saved?.results.length ? revision : null;
};

export const suggestCompany = async (
  db: PeopleDb,
  email: string,
  managed: string[],
) => {
  if (managed.includes(normalizePersonEmail(email))) return null;
  const companies = (await listPeople(db, managed)).filter(
    (person) => person.kind === "company",
  );
  return (
    companyForHostname(companies, email.slice(email.lastIndexOf("@") + 1)) ??
    null
  );
};
