import { normalizeCompanyDomain } from "../company-domains.ts";
import type { MailFilters, MailPeople } from "../inbox-contract.ts";
import { normalizePersonEmail } from "../people-contract.ts";
import type { MailDatabase } from "./mailbox.ts";
import { listPeople, managedPersonAddresses } from "./people-store.ts";

export type ContactFilters = {
  people?: ReadonlySet<string>;
  companies?: {
    domains: ReadonlySet<string>;
    ownAddresses: ReadonlySet<string>;
  };
};

export const hasEmptyContactFilter = ({ people, companies }: ContactFilters) =>
  people?.size === 0 || companies?.domains.size === 0;

export const resolveContactFilters = async (
  db: MailDatabase,
  { people, companies }: Pick<MailFilters, "people" | "companies">,
  mailboxAddresses: readonly string[],
): Promise<ContactFilters> => {
  if (!people.length && !companies.length) return {};
  const contacts = await listPeople(
    db,
    people.length ? await managedPersonAddresses(db) : [],
    [...people, ...companies],
  );
  const selectedPeople = contacts.filter(
    (person) => person.kind !== "company" && people.includes(person.id),
  );
  const selectedCompanies = contacts.filter(
    (person) => person.kind === "company" && companies.includes(person.id),
  );
  return {
    ...(people.length
      ? {
          people: new Set(
            selectedPeople.flatMap(({ addresses, managedAddresses }) => [
              ...addresses,
              ...managedAddresses,
            ]),
          ),
        }
      : {}),
    ...(companies.length
      ? {
          companies: {
            domains: new Set(
              selectedCompanies.flatMap(({ domains }) => domains ?? []),
            ),
            ownAddresses: new Set(mailboxAddresses.map(normalizePersonEmail)),
          },
        }
      : {}),
  };
};

const members =
  "member.mailbox_id = m.mailbox_id AND member.thread_id = m.thread_id AND member.deleted = 0";
const address = "lower(trim(json_extract(participant.value, '$.address')))";
const hasParticipant = (condition: string) => `EXISTS (
  SELECT 1 FROM mail_index_messages member, json_each(member.people, '$.members') participant
  WHERE ${members} AND (${condition})
)`;

export const contactFilterQuery = ({ people, companies }: ContactFilters) => {
  const conditions: string[] = [];
  const values: string[] = [];
  const json = (set: ReadonlySet<string>) => JSON.stringify([...set]);
  if (people) {
    conditions.push(
      hasParticipant(`${address} IN (SELECT value FROM json_each(?))`),
    );
    values.push(json(people));
  }
  if (companies) {
    conditions.push(
      hasParticipant(`
      ${address} NOT IN (SELECT value FROM json_each(?))
      AND EXISTS (
        SELECT 1 FROM json_each(?) domain
        WHERE substr(rtrim(${address}, '.'), -length(domain.value) - 1)
          IN ('@' || domain.value, '.' || domain.value)
      )
    `),
    );
    values.push(json(companies.ownAddresses), json(companies.domains));
  }
  // Older rows have just the raw sender/recipient fields until their
  // formatted addresses are rebuilt. Pass those threads on to the parser.
  const hasLegacyMembers = conditions.length
    ? `EXISTS (SELECT 1 FROM mail_index_messages member WHERE ${members} AND member.people IS NULL)`
    : "";
  return {
    where: hasLegacyMembers
      ? `AND ((${conditions.join(" AND ")}) OR ${hasLegacyMembers})`
      : "",
    hasLegacyMembers,
    values,
  };
};

export const matchesContactFilters = (
  { people, companies }: ContactFilters,
  participants: (typeof MailPeople.Type)["members"],
) => {
  const addresses = participants.map(({ address }) =>
    normalizePersonEmail(address),
  );
  return (
    (!people || addresses.some((address) => people.has(address))) &&
    (!companies ||
      addresses.some((address) => {
        const at = address.lastIndexOf("@");
        if (at === -1 || companies.ownAddresses.has(address)) return false;
        const host = normalizeCompanyDomain(address.slice(at + 1));
        return [...companies.domains].some(
          (domain) => host === domain || host.endsWith(`.${domain}`),
        );
      }))
  );
};
