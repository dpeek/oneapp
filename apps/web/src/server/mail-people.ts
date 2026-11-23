import { inferSenderAppearance, type SenderHeader } from "./mail-sender.ts";
import { addressParser } from "postal-mime";
import type { MailPeople, MailPerson } from "../inbox-contract.ts";

const readAddresses = (value: string | null | undefined): MailPerson[] =>
  value
    ? addressParser(value, { flatten: true }).flatMap(({ address, name }) =>
        address && address.length <= 254
          ? [{ address, name: name.trim().slice(0, 200) }]
          : [],
      )
    : [];

export const mailPeople = (
  header: (
    name: "from" | "to" | "cc" | "bcc" | SenderHeader,
  ) => string | null | undefined,
  from: string,
  to: string,
): MailPeople => {
  const authors = readAddresses(header("from"));
  const [author] = authors.length ? authors : readAddresses(from);
  // A fallback may be a delivery envelope or our own outbound address; only
  // infer organization identity from an actual visible From header.
  const appearance =
    authors.length && author && inferSenderAppearance(author, header);
  const sender = author && { ...author, ...(appearance ? { appearance } : {}) };
  const members = new Map<string, MailPerson>();
  const addresses = [
    ...(sender ? [sender] : []),
    ...authors,
    ...readAddresses(header("to")),
    ...readAddresses(header("cc")),
    ...readAddresses(header("bcc")),
    ...readAddresses(to),
  ];
  for (const person of addresses) {
    const key = person.address.toLowerCase();
    if (!members.has(key) || (!members.get(key)?.name && person.name))
      members.set(key, person);
  }
  return { sender: sender ?? null, members: [...members.values()] };
};
