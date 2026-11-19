import { Schema } from "effect";
import type { Email } from "postal-mime";
import { ComposeRecipient } from "../inbox-contract.ts";
import type { SentReply } from "./sent-mail.ts";

const readRecipient = Schema.decodeUnknownOption(ComposeRecipient);

export const replyRecipient = (email: Email | null, envelopeFrom: string) => {
  const addresses = [
    ...(email?.replyTo ?? []).flatMap((address) =>
      address.group
        ? address.group.map((member) => member.address)
        : [address.address],
    ),
    email?.from?.address,
    envelopeFrom,
  ];
  for (const address of addresses) {
    const recipient = readRecipient(address);
    if (recipient._tag === "Some") return recipient.value;
  }
  return undefined;
};

// Extract only bracketed IDs from unfolded headers. ASCII keeps the Cloudflare
// byte limit equivalent to the string length and excludes header delimiters.
const parseMessageIds = (value: string | null | undefined) =>
  (
    value?.match(
      /<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+|\[[A-Za-z0-9:.%-]+\])>/gu,
    ) ?? []
  ).filter((id) => id.length <= 998);

const messageIds = (email: Email, name: string) =>
  parseMessageIds(email.headers.find(({ key }) => key === name)?.value);

export type ThreadHeader = "message-id" | "references" | "in-reply-to";

export const conversationMessageIds = (
  header: (name: ThreadHeader) => string | null | undefined,
) => {
  const ancestors = [
    ...parseMessageIds(header("references")),
    ...parseMessageIds(header("in-reply-to")),
  ];
  const [root] = ancestors;
  return [
    ...new Set([
      ...(root ? [root] : []),
      ...ancestors.slice(-63),
      ...parseMessageIds(header("message-id")).slice(0, 1),
    ]),
  ];
};

export const outboundMessageId = (id: string) => {
  const candidate = id.startsWith("<") ? id : `<${id}>`;
  return parseMessageIds(candidate).find((match) => match === candidate);
};

export const parentMessageId = (email: Email) =>
  messageIds(email, "message-id")[0];

export const buildReplyHeaders = (
  header: (name: ThreadHeader) => string | undefined,
): SentReply["headers"] => {
  const parent = parseMessageIds(header("message-id"))[0];
  const references = parseMessageIds(header("references"));
  const previousParent = parseMessageIds(header("in-reply-to"));
  const ancestors = new Set(
    references.length
      ? references
      : previousParent.length === 1
        ? previousParent
        : [],
  );
  if (parent) ancestors.delete(parent);
  if (!parent && ancestors.size === 0) return undefined;

  // Keep the thread root and as much recent history as fits the provider limit.
  const [root, ...rest] = ancestors;
  let available = 2_048 - (parent?.length ?? 0) - (root ? root.length + 1 : 0);
  const recent = [];
  for (const id of rest.reverse()) {
    if (id.length + 1 > available) break;
    recent.push(id);
    available -= id.length + 1;
  }
  return {
    ...(parent ? { "In-Reply-To": parent } : {}),
    References: [
      ...(root ? [root] : []),
      ...recent.reverse(),
      ...(parent ? [parent] : []),
    ].join(" "),
  };
};

export const replyHeaders = (email: Email) =>
  buildReplyHeaders(
    (name) => email.headers.find(({ key }) => key === name)?.value,
  );
