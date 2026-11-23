import type { D1Database } from "@cloudflare/workers-types";
import type {
  MailPeople,
  MailPerson,
  SenderAppearanceUpdate,
} from "../inbox-contract.ts";
import { normalizePersonEmail } from "../people-contract.ts";
import { senderIconDomain } from "./mail-sender.ts";

type Kind = "person" | "service";
export const senderAppearanceRules = async (
  db: D1Database,
  addresses: readonly string[],
) => {
  if (!addresses.length) return new Map<string, Kind>();
  const { results } = await db
    .prepare(
      "SELECT address, kind FROM mail_sender_avatars WHERE address IN (SELECT value FROM json_each(?))",
    )
    .bind(JSON.stringify([...new Set(addresses.map(normalizePersonEmail))]))
    .all<{ address: string; kind: Kind }>();
  return new Map(results.map(({ address, kind }) => [address, kind]));
};

export const applySenderAppearance = (
  people: MailPeople,
  rules: ReadonlyMap<string, Kind>,
): MailPeople => {
  const sender = people.sender;
  const kind = sender && rules.get(normalizePersonEmail(sender.address));
  if (!sender || !kind) return people;
  const updated: MailPerson = {
    ...sender,
    appearance: {
      kind,
      mode: kind,
      domain: kind === "service" ? senderIconDomain(sender.address) : null,
    },
  };
  return {
    sender: updated,
    members: people.members.map((member) =>
      normalizePersonEmail(member.address) ===
      normalizePersonEmail(sender.address)
        ? { ...member, appearance: updated.appearance }
        : member,
    ),
  };
};

export const withSenderAppearances = async <T extends { people?: MailPeople }>(
  db: D1Database,
  messages: readonly T[],
): Promise<T[]> => {
  const rules = await senderAppearanceRules(
    db,
    messages.flatMap(({ people }) =>
      people?.sender ? [people.sender.address] : [],
    ),
  );
  return messages.map((message) =>
    message.people
      ? { ...message, people: applySenderAppearance(message.people, rules) }
      : message,
  );
};

export const setSenderAppearance = (
  db: D1Database,
  { address, mode }: typeof SenderAppearanceUpdate.Type,
) =>
  mode === "auto"
    ? db
        .prepare("DELETE FROM mail_sender_avatars WHERE address = ?")
        .bind(normalizePersonEmail(address))
        .run()
    : db
        .prepare(
          "INSERT INTO mail_sender_avatars (address, kind) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET kind = excluded.kind",
        )
        .bind(normalizePersonEmail(address), mode)
        .run();
