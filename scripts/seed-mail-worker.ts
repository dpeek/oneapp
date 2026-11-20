import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import type { WorkerEnv } from "../alchemy.run.ts";
import {
  indexMail,
  setThreadArchived,
} from "../apps/web/src/server/mail-index.ts";
import { mailPeople } from "../apps/web/src/server/mail-people.ts";
import { conversationMessageIds } from "../apps/web/src/server/mail-reply.ts";
import { managedPersonAddresses } from "../apps/web/src/server/people-store.ts";
import { describeSent, saveSent } from "../apps/web/src/server/sent-mail.ts";

// Stable IDs make reruns additive, including after an interrupted seed.
const fixtureDate = Date.UTC(2026, 10, 20, 2);
const hour = 3_600_000;
const key = (number: number, timestamp: number) =>
  `0-${9_999_999_999_999 - timestamp}-286dd67a-8a58-47f6-acc3-${String(number).padStart(12, "0")}`;
const messageId = (number: number) =>
  `<oneapp-mail-fixture-${number}@example.test>`;
type MailStore = Pick<WorkerEnv, "DB" | "INBOX_MESSAGES" | "SENT_MESSAGES">;

const indexed = (DB: MailStore["DB"], id: string) =>
  DB.prepare("SELECT 1 FROM mail_index_messages WHERE id = ?").bind(id).first();

type Incoming = {
  number: number;
  timestamp: number;
  from: string;
  to: string;
  subject: string;
  body: string;
  unread?: boolean;
  references?: readonly number[];
  list?: boolean;
  attachment?: boolean;
  archived?: boolean;
};

const receive = async ({ DB, INBOX_MESSAGES }: MailStore, mail: Incoming) => {
  const id = `${key(mail.number, mail.timestamp)}.eml`;
  if (await indexed(DB, id)) return 0;
  const sender = mail.from.match(/<([^>]+)>/u)?.[1] ?? mail.from;
  const headers: Record<string, string> = {
    From: mail.from,
    To: mail.to,
    Subject: mail.subject,
    Date: new Date(mail.timestamp).toUTCString(),
    "Message-ID": messageId(mail.number),
    "MIME-Version": "1.0",
    "Content-Type": mail.attachment
      ? 'multipart/mixed; boundary="oneapp-fixture"'
      : "text/plain; charset=utf-8",
  };
  if (mail.references?.length) {
    headers.References = mail.references.map(messageId).join(" ");
    headers["In-Reply-To"] = headers.References.split(" ").at(-1)!;
  }
  if (mail.list) headers["List-ID"] = "Studio bulletin <studio.example.test>";
  const body = mail.attachment
    ? [
        "--oneapp-fixture",
        "Content-Type: text/plain; charset=utf-8",
        "",
        mail.body,
        "--oneapp-fixture",
        'Content-Type: text/plain; name="launch-checklist.txt"',
        'Content-Disposition: attachment; filename="launch-checklist.txt"',
        "",
        "Launch checklist",
        "",
        "[x] Review mobile layout",
        "[ ] Confirm contrast",
        "--oneapp-fixture--",
      ]
    : [mail.body];
  const raw = [
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    ...body,
    "",
  ]
    .join("\n")
    .replaceAll("\n", "\r\n");
  await INBOX_MESSAGES.put(id, raw, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: {
      envelopeFrom: sender,
      envelopeTo: mail.to,
      subject: mail.subject,
      initialUnread: mail.unread ? "1" : "0",
    },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  const lookup = new Headers(headers);
  await indexMail(DB, {
    id,
    folder: "inbox",
    timestamp: mail.timestamp,
    from: sender,
    to: mail.to,
    subject: mail.subject,
    unread: mail.unread,
    listMail: mail.list ?? false,
    people: mailPeople((name) => lookup.get(name), sender, mail.to),
    messageIds: conversationMessageIds((name) => lookup.get(name)),
  });
  if (mail.archived) await setThreadArchived(DB, id, true);
  return 1;
};

const seedMail = async (env: MailStore) => {
  const { DB, SENT_MESSAGES } = env;
  const [owner] = await managedPersonAddresses(DB);
  const mailbox = owner ?? "mailbox@example.test";
  const alice = "Alice Nguyen <alice@example.test>";
  const people = [
    alice,
    "Sam Rivera <sam@example.test>",
    "Morgan Chen <morgan@example.test>",
    "Imani Jones <imani@example.test>",
  ];
  const subject = "Project Beacon launch review";
  const rootDate = fixtureDate - 48 * hour;
  let added = 0;
  added += await receive(env, {
    number: 1,
    timestamp: rootDate,
    from: alice,
    to: mailbox,
    subject,
    body: "Hi team,\n\nCan we review the launch list before Friday? The two open questions are the mobile layout and who signs off on the release.\n\nThanks,\nAlice",
  });
  const reply = {
    id: key(2, rootDate + hour),
    from: mailbox,
    to: "alice@example.test",
    subject: `Re: ${subject}`,
    sentAt: rootDate + hour,
    providerMessageId: messageId(2),
    text: "I can take the mobile review. Let's use the staging screenshots in tomorrow's walkthrough.",
    reply: {
      originalId: `${key(1, rootDate)}.eml`,
      headers: { "In-Reply-To": messageId(1), References: messageId(1) },
    },
  };
  if (!(await indexed(DB, reply.id))) {
    if (
      !(await SENT_MESSAGES.head(reply.id)) &&
      !(await Effect.runPromise(saveSent(SENT_MESSAGES, reply)))
    )
      throw new Error("Could not write the local sent fixture.");
    await indexMail(DB, describeSent(reply));
    added++;
  }
  for (const [index, body] of [
    "I added screenshots for both mobile widths and checked the keyboard order.",
    "The conversation list looks good. Let's double-check long subject lines.",
    "The contrast fixes are ready. I will have a final pass by lunchtime.",
    "Thanks, everyone. Here is the checklist we can use during the review.",
    "Final update: the review is at 2 pm. Please add any blocking issues before then.\n\nOn Thursday, Alice wrote:\n> Here is the checklist we can use during the review.",
  ].entries()) {
    const number = index + 3;
    added += await receive(env, {
      number,
      timestamp: index === 4 ? fixtureDate : rootDate + (index + 2) * hour,
      from: people[(index + 1) % people.length]!,
      to: mailbox,
      subject: `Re: ${subject}`,
      body,
      references: Array.from({ length: number - 1 }, (_, offset) => offset + 1),
      unread: index === 4,
      attachment: index === 3,
    });
  }
  for (const [index, subject] of [
    "Friday design review",
    "Lunch next week?",
    "Updated project timeline",
    "Notes from the studio check-in",
    "Accessibility pass on the new navigation",
    "One small follow-up",
    "Travel confirmation",
    "Can you review the final copy?",
    "Team planning for December",
    "A quick update on the prototype",
    "Receipt for the studio supplies",
    "Workshop notes and next steps",
    "Long subject to check truncation when an item also has a timestamp and an unread badge",
    "Reference links for the conversation layout",
    "October budget summary",
    "Please confirm the venue",
    "Shared folder permissions",
    "Preview is ready",
    "Thanks for the walkthrough",
    "",
  ].entries()) {
    added += await receive(env, {
      number: index + 10,
      timestamp: fixtureDate - (index + 1) * 9 * hour,
      from: people[index % people.length]!,
      to: mailbox,
      subject,
      body: "Hi,\n\nI wanted to add this to your list before our next check-in. Let me know if you have any questions.\n\nThanks!",
      unread: index % 3 === 0,
    });
  }
  for (const [index, subject] of [
    "Studio bulletin",
    "Weekly links roundup",
    "November events digest",
  ].entries()) {
    added += await receive(env, {
      number: 30 + index,
      timestamp: fixtureDate - (index + 1) * 24 * hour,
      from: "Studio Bulletin <digest@example.test>",
      to: mailbox,
      subject,
      list: true,
      body: "This week: an open studio on Wednesday, a new reading list, and a reminder about the Friday review.",
      unread: index === 0,
    });
  }
  added += await receive(env, {
    number: 33,
    timestamp: fixtureDate - 200 * hour,
    from: alice,
    to: mailbox,
    subject: "Resolved: Room booking",
    body: "The training room is confirmed. Thanks for sorting it out!",
    archived: true,
  });
  return added;
};

export class SeedMail extends DurableObject<MailStore> {
  run() {
    return seedMail(this.env);
  }
}
