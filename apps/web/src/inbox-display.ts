import type { ConversationMessage, MailPerson } from "./inbox-contract.ts";

export const conversationSubject = (
  messages: readonly Pick<ConversationMessage, "subject">[],
) =>
  messages
    .map(({ subject }) => subject.replace(/^(?:\s*re\s*:\s*)+/iu, "").trim())
    .find(Boolean) || "(No subject)";

export const conversationPeople = (
  messages: readonly Pick<ConversationMessage, "people">[],
) => {
  const people = new Map<string, MailPerson>();
  for (const message of messages) {
    for (const person of message.people?.members ?? []) {
      const key = person.address.toLowerCase();
      if (!people.has(key) || (!people.get(key)?.name && person.name))
        people.set(key, person);
    }
  }
  return [...people.values()];
};

export const collapsibleMiddleCount = (
  messages: readonly Pick<ConversationMessage, "id" | "unread">[],
  protectedIds: readonly (string | null | undefined)[],
) => {
  const middle = messages.slice(1, -2);
  return middle.some(({ id, unread }) => unread || protectedIds.includes(id))
    ? 0
    : middle.length;
};

const timeOnly = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const dayOnly = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const dayAndYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "2-digit",
});

export const compactMailTime = (timestamp: number, now = new Date()) => {
  const date = new Date(timestamp);
  if (date.toDateString() === now.toDateString()) return timeOnly.format(date);
  return (
    date.getFullYear() === now.getFullYear() ? dayOnly : dayAndYear
  ).format(date);
};

const quoteLine = (line: string | undefined) => /^[\t ]*>/u.test(line ?? "");
const attribution = (line: string | undefined) =>
  /\bwrote:\s*$/iu.test(line ?? "");
const forwarded =
  /^\s*(?:-{2,}\s*(?:original|forwarded) message\s*-{2,}|begin forwarded message:)\s*$/iu;

const originalHeader = (lines: string[], start: number) => {
  if (!/^from:\s+\S/iu.test(lines[start] ?? "")) return false;
  const block = lines.slice(start + 1, start + 8);
  return (
    block.some((line) => /^(?:sent|date):/iu.test(line)) &&
    block.some((line) => /^to:/iu.test(line)) &&
    block.some((line) => /^subject:/iu.test(line))
  );
};

export const splitMailQuote = (text: string) => {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const parts: { quoted: boolean; text: string }[] = [];
  let start = 0;
  const add = (from: number, to: number, quoted: boolean) => {
    const block = lines
      .slice(from, to)
      .join("\n")
      .replace(/^\n+|\n+$/gu, "");
    const text = quoted ? block.replace(/^[\t ]*>[\t ]?/gmu, "") : block;
    if (text.trim()) parts.push({ quoted, text });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const datedAttribution = /^On\s.*\d.*\bwrote:\s*$/iu.test(line);
    let next = index + 1;
    if (datedAttribution) {
      while (lines[next] !== undefined && !lines[next]?.trim()) next += 1;
    }
    const unprefixed =
      next < lines.length && datedAttribution && !quoteLine(lines[next]);
    if (forwarded.test(line) || originalHeader(lines, index) || unprefixed) {
      add(start, index, false);
      add(index, lines.length, true);
      return parts;
    }
    if (!quoteLine(line)) continue;
    let quoteStart = index;
    let previous = index - 1;
    while (previous >= start && !lines[previous]?.trim()) previous -= 1;
    if (previous >= start && attribution(lines[previous])) {
      quoteStart = previous;
      // Reply attributions sometimes wrap before the final “wrote:” line.
      for (
        let candidate = previous - 1;
        candidate >= Math.max(start, previous - 3);
        candidate -= 1
      ) {
        const preceding = lines[candidate];
        if (!preceding?.trim()) break;
        if (/^On\s/iu.test(preceding)) {
          quoteStart = candidate;
          break;
        }
      }
    }
    let end = index + 1;
    while (
      quoteLine(lines[end]) ||
      (lines[end] !== undefined && !lines[end]?.trim())
    )
      end += 1;
    add(start, quoteStart, false);
    add(quoteStart, end, true);
    start = end;
    index = end - 1;
  }
  add(start, lines.length, false);
  return parts;
};
