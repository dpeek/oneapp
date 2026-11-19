import { Schema } from "effect";
import type { Email } from "postal-mime";
import { ComposeRecipient } from "../inbox-contract.ts";
import type { SentReply } from "./sent-mail.ts";

const readRecipient = Schema.decodeUnknownOption(ComposeRecipient);

export const replyRecipient = (email: Email, envelopeFrom: string) => {
  const addresses = [
    ...(email.replyTo ?? []).flatMap((address) =>
      address.group
        ? address.group.map((member) => member.address)
        : [address.address],
    ),
    email.from?.address,
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
const messageIds = (email: Email, name: string) =>
  (
    email.headers
      .find(({ key }) => key === name)
      ?.value.match(
        /<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+|\[[A-Za-z0-9:.%-]+\])>/gu,
      ) ?? []
  ).filter((id) => id.length <= 998);

export const parentMessageId = (email: Email) =>
  messageIds(email, "message-id")[0];

export const replyHeaders = (email: Email): SentReply["headers"] => {
  const parent = parentMessageId(email);
  const references = messageIds(email, "references");
  const previousParent = messageIds(email, "in-reply-to");
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
