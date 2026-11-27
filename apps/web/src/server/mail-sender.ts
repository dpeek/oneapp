import type { MailPerson } from "../inbox-contract.ts";
import { isEmail, senderDomain, senderIconDomain } from "../mail-domain.ts";

export type SenderHeader = "auto-submitted" | "list-id" | "list-unsubscribe";
// Token boundaries catch product-noreply and invoice+account IDs without
// turning personal names such as Billingham or AnnAccounts into role mailboxes.
const noReply =
  /(?:^|[+._-])(?:no[._-]?reply|do[._-]?not[._-]?reply)(?:$|[+._-])/iu;
const strongRole =
  /^(?:notifications?|notify|accounts?|billing|receipts?|invoices?|marketing|newsletters?|confirm|verify|verification|auto[._-]?confirm|shipment[._-]?tracking|order[._-]?updates?|upcoming[._-]?invoice|jobmail|ticketing|ticketoffice|(?:online)?customer[._-]?(?:support|service)|fieldservice)(?:[+._-].*)?$/iu;
const sharedRole =
  /^(?:support|hello|hi|info|team|news|updates?|alerts?|orders?|security|mail|email|office|admin|sales|service|contact|help|customerservice|admissions|reservations?|bookings?|membership|recruiting|events?|documents?|reports?|store|product)(?:[+._-].*)?$/iu;
const deliverySubdomain =
  /^(?:mail|email|em|e|m|t|s|news|newsletters?|notifications?|notices?|messages?|messaging|updates?|alerts?|comms|communications?|post|reply|information)[0-9]*$/iu;
const organizationWords =
  /\b(?:inc|llc|ltd|pty|company|corporation|collective|department|office|support|team|school|university|hospital|investments|securities|accountants)\b/iu;
const compact = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

const nameSignals = (name: string, local: string, brand: string) => {
  const words = name
    .replace(/\([^)]*\)/gu, "")
    .replace(/^(?:dr|mr|mrs|ms|prof)\.?\s+/iu, "")
    .trim()
    .split(/\s+/u);
  const nameShaped =
    words.length >= 2 &&
    words.length <= 4 &&
    words.every((word) => /^[\p{L}][\p{L}'’.-]*$/u.test(word));
  const first = compact(words[0] ?? "");
  const last = compact(words.at(-1) ?? "");
  const mailbox = compact(local.split("+", 1)[0]!);
  const branded =
    brand.length >= 3 &&
    (compact(name).startsWith(brand) ||
      name.split(/[^\p{L}\p{N}]+/u).some((word) => compact(word) === brand));
  const organization = organizationWords.test(name) || branded;
  // A named employee on a company domain is still a person. This is evidence,
  // not a general name recognizer; unknown names keep the conservative default.
  const personalMailbox =
    nameShaped &&
    !organizationWords.test(name) &&
    [
      first,
      first + last,
      first.slice(0, 1) + last,
      first + last.slice(0, 1),
    ].includes(mailbox);
  return {
    organization,
    personalMailbox,
    person: personalMailbox || (nameShaped && !organization),
  };
};
const listHeader = (value: string | null | undefined) =>
  /<[^<>\s]+>/u.test(value ?? "");

export const inferSenderAppearance = (
  sender: Pick<MailPerson, "address" | "name">,
  header: (name: SenderHeader) => string | null | undefined,
): MailPerson["appearance"] => {
  if (!isEmail(sender.address)) return undefined;
  const local = sender.address.slice(0, sender.address.lastIndexOf("@"));
  const domain = senderDomain(sender.address);
  const brand = compact(domain?.domainWithoutSuffix ?? "");
  const name = nameSignals(sender.name, local, brand);
  const subdomain = domain && !domain.personal ? domain.subdomain : null;
  const delivery =
    subdomain?.split(".").some((label) => deliverySubdomain.test(label)) ??
    false;
  const brandMailbox =
    !domain?.personal &&
    brand.length >= 3 &&
    compact(local.split("+", 1)[0]!) === brand;
  const generated =
    header("auto-submitted")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "auto-generated";
  const list =
    listHeader(header("list-id")) || listHeader(header("list-unsubscribe"));
  // Generic subdomains need corroboration: government departments, universities
  // and personal mail providers also issue addresses below a registrable domain.
  // Delivery-specific subdomains and transactional mailboxes are stronger signals.
  const service =
    noReply.test(local) ||
    strongRole.test(local) ||
    delivery ||
    ((name.organization || brandMailbox || generated) &&
      !name.personalMailbox) ||
    ((sharedRole.test(local) || Boolean(subdomain)) && !name.person) ||
    (list && (sharedRole.test(local) || !sender.name.trim()));
  return service
    ? {
        kind: "service",
        mode: "auto",
        domain: senderIconDomain(sender.address),
      }
    : undefined;
};
