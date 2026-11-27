import type { D1Database } from "@cloudflare/workers-types";
import { Schema } from "effect";
import type { CompanyAvatarStyle } from "../company-avatar-contract.ts";
import { isCompanyDomain, normalizeCompanyDomain } from "../company-domains.ts";
import {
  normalizePersonEmail,
  PersonEmail,
  type ContactKind,
  type Person,
  type PersonMatch,
} from "../people-contract.ts";
import { senderIconDomain } from "../mail-domain.ts";
import { ownerId } from "./auth.ts";

type PeopleDb = D1Database;
const isPersonEmail = Schema.is(PersonEmail);
type PersonRow = {
  id: string;
  accountId: string | null;
  name: string;
  kind: "person" | "company";
  domains: string;
  iconEmail: string | null;
  photo: string | null;
  avatarStyle: CompanyAvatarStyle | null;
  revision: string;
};
const fields = `p.id, p.account_id AS accountId, p.name, p.photo, p.avatar_style AS avatarStyle, p.revision, p.kind,
  (SELECT json_group_array(domain ORDER BY position) FROM company_domains WHERE company_id = p.id) AS domains,
  (SELECT email FROM person_addresses WHERE person_id = p.id ORDER BY email LIMIT 1) AS iconEmail`;
const fieldsWithAddresses = `${fields},
  (SELECT json_group_array(email ORDER BY email) FROM person_addresses WHERE person_id = p.id) AS emails`;
type PersonWithEmails = PersonRow & { emails: string };

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
        ...(row.avatarStyle ? { avatarStyle: row.avatarStyle } : {}),
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

export const listPeople = async (
  db: PeopleDb,
  managed: string[],
  ids?: readonly string[],
) => {
  if (!ids) await ensureSelf(db);
  const { results } = await db
    .prepare(
      `SELECT ${fieldsWithAddresses} FROM people p
       ${ids ? "WHERE p.id IN (SELECT value FROM json_each(?))" : ""}`,
    )
    .bind(...(ids ? [JSON.stringify(ids)] : []))
    .all<PersonWithEmails>();
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

// Walk whole DNS labels from the most specific hostname to its parents.
const domainCandidates = (hostname: string) => {
  const labels = normalizeCompanyDomain(hostname).split(".");
  return labels.slice(0, -1).map((_, offset) => labels.slice(offset).join("."));
};

const companiesByDomain = async (db: PeopleDb, domains: string[]) => {
  const { results } = await db
    .prepare(
      `SELECT d.domain, ${fields}
       FROM company_domains d JOIN people p ON p.id = d.company_id
       WHERE p.kind = 'company'
         AND d.domain IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(domains))
    .all<PersonRow & { domain: string }>();
  return new Map(results.map((row) => [row.domain, summary(row)]));
};

export const matchPeople = async (
  db: PeopleDb,
  addresses: string[],
  managed: string[],
  { createSelf = true } = {},
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
    const row = await (createSelf ? ensureSelf(db) : findSelf(db));
    for (const email of selfEmails) {
      if (row) matches.set(email, summary(row));
      else matches.delete(email);
    }
  }

  const domainsByEmail = new Map<string, string[]>();
  for (const email of emails) {
    if (
      matches.has(email) ||
      selfEmails.includes(email) ||
      !isPersonEmail(email)
    )
      continue;
    domainsByEmail.set(
      email,
      domainCandidates(email.slice(email.lastIndexOf("@") + 1)),
    );
  }
  if (domainsByEmail.size) {
    const domains = [...new Set([...domainsByEmail.values()].flat())];
    const byDomain = await companiesByDomain(db, domains);
    for (const [email, candidates] of domainsByEmail) {
      const company = candidates
        .map((domain) => byDomain.get(domain))
        .find(Boolean);
      if (company) matches.set(email, company);
    }
  }
  return [...matches].map(([email, person]) => ({ email, person }));
};

export const searchPeople = async (
  db: PeopleDb,
  managed: string[],
  {
    query,
    kind,
    limit,
    offset,
  }: {
    query: string;
    kind?: ContactKind;
    limit: number;
    offset: number;
  },
) => {
  let matchedId: string | null = null;
  const email = normalizePersonEmail(query);
  if (isPersonEmail(email)) {
    const [match] = await matchPeople(db, [email], managed, {
      createSelf: false,
    });
    matchedId = match?.person.id ?? null;
  } else if (isCompanyDomain(query)) {
    const candidates = domainCandidates(query);
    const companies = await companiesByDomain(db, candidates);
    matchedId =
      candidates.map((domain) => companies.get(domain)).find(Boolean)?.id ??
      null;
  }
  const { results } = await db
    .prepare(
      `SELECT ${fieldsWithAddresses} FROM people p
       WHERE (?1 IS NULL OR p.kind = ?1)
         AND (?2 = '' OR instr(lower(p.name), lower(?2)) > 0 OR p.id = ?3)
       ORDER BY (p.id IS ?3) DESC, p.name COLLATE NOCASE, p.id
       LIMIT ?4 OFFSET ?5`,
    )
    .bind(kind ?? null, query, matchedId, limit, offset)
    .all<PersonWithEmails>();
  return results.map((row) =>
    withAddresses(row, JSON.parse(row.emails), managed),
  );
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
  avatarStyle: CompanyAvatarStyle | null = null,
) => {
  const revision = crypto.randomUUID();
  const matchesRevision =
    "EXISTS (SELECT 1 FROM people WHERE id = ?1 AND revision = ?2)";
  const [saved] = await db.batch<{ id: string }>([
    currentRevision
      ? db
          .prepare(
            "UPDATE people SET name = ?, photo = ?, revision = ?, kind = ?, avatar_style = ? WHERE id = ? AND revision = ? RETURNING id",
          )
          .bind(name, photo, revision, kind, avatarStyle, id, currentRevision)
      : db
          .prepare(
            "INSERT INTO people (id, name, photo, revision, kind, avatar_style) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
          )
          .bind(id, name, photo, revision, kind, avatarStyle),
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

const contactUndoLifetime = 60 * 60_000;

export const deleteContact = async (
  db: PeopleDb,
  id: string,
  revision: string,
  now = Date.now(),
) => {
  // Store the snapshot before the cascading delete releases addresses and domains.
  const [, , deleted] = await db.batch<{ receipt: string }>([
    db
      .prepare(
        `INSERT INTO contact_deletions
           (id, receipt, revision, name, kind, photo, avatar_style, addresses, domains, expires_at)
         SELECT p.id, ?3, p.revision, p.name, p.kind, p.photo, p.avatar_style,
           (SELECT json_group_array(email ORDER BY email) FROM person_addresses WHERE person_id = p.id),
           (SELECT json_group_array(domain ORDER BY position) FROM company_domains WHERE company_id = p.id),
           ?4
         FROM people p WHERE p.id = ?1 AND p.revision = ?2 AND p.account_id IS NULL
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(id, revision, crypto.randomUUID(), now + contactUndoLifetime),
    db
      .prepare(
        `DELETE FROM people WHERE id = ?1 AND revision = ?2 AND account_id IS NULL
           AND EXISTS (SELECT 1 FROM contact_deletions WHERE id = ?1 AND revision = ?2)`,
      )
      .bind(id, revision),
    db
      .prepare(
        "SELECT receipt FROM contact_deletions WHERE id = ? AND revision = ? AND expires_at > ?",
      )
      .bind(id, revision, now),
  ]);
  const receipt = deleted?.results[0]?.receipt;
  if (receipt) return { status: "ok", receipt } as const;
  const current = await db
    .prepare("SELECT account_id FROM people WHERE id = ?")
    .bind(id)
    .first<{ account_id: string | null }>();
  if (!current) return { status: "missing" } as const;
  return { status: current.account_id ? "protected" : "stale" } as const;
};

export const restoreContact = async (
  db: PeopleDb,
  receipt: string,
  now = Date.now(),
) => {
  const revision = crypto.randomUUID();
  const restored =
    "d.receipt = ?1 AND EXISTS (SELECT 1 FROM people p WHERE p.id = d.id AND p.revision = ?2)";
  const [result] = await db.batch<{ id: string }>([
    db
      .prepare(
        `INSERT INTO people (id, name, kind, photo, avatar_style, revision)
         SELECT id, name, kind, photo, avatar_style, ?2 FROM contact_deletions
         WHERE receipt = ?1 AND expires_at > ?3 RETURNING id`,
      )
      .bind(receipt, revision, now),
    db
      .prepare(
        `INSERT INTO person_addresses (email, person_id)
         SELECT entry.value, d.id FROM contact_deletions d, json_each(d.addresses) entry
         WHERE ${restored}`,
      )
      .bind(receipt, revision),
    db
      .prepare(
        `INSERT INTO company_domains (domain, company_id, position)
         SELECT entry.value, d.id, entry.key FROM contact_deletions d, json_each(d.domains) entry
         WHERE ${restored}`,
      )
      .bind(receipt, revision),
    db
      .prepare(`DELETE FROM contact_deletions AS d WHERE ${restored}`)
      .bind(receipt, revision),
  ]);
  return result?.results[0]?.id ?? null;
};
