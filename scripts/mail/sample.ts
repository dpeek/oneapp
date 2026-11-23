import type { ImapFlow } from "imapflow";
import { Schema } from "effect";
import { MailSampleError } from "./errors.ts";
import { MailImportMetadata } from "../../apps/web/src/server/mail-import.ts";
import { parseRawHeaders } from "../../apps/web/src/server/raw-mail.ts";
import { conversationMessageIds } from "../../apps/web/src/server/mail-reply.ts";

export const sampleFolders = [
  { path: "INBOX", folder: "inbox" as const, archived: false },
  { path: "Sent Messages", folder: "sent" as const, archived: false },
  { path: "Archive", folder: "inbox" as const, archived: true },
];
export const sampleLimits = {
  perFolder: 10,
  messages: 100,
  bytes: 100 * 1024 * 1024,
  messageBytes: 25 * 1024 * 1024,
};
export const SampleMessage = Schema.Struct({
  metadata: MailImportMetadata,
  size: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type SampleMessage = typeof SampleMessage.Type;
export const SamplePlan = Schema.Struct({
  version: Schema.Literal(1),
  account: Schema.String,
  stage: Schema.String,
  resources: Schema.Struct({
    inbox: Schema.String,
    sent: Schema.String,
    database: Schema.String,
  }),
  createdAt: Schema.String,
  messages: Schema.Array(SampleMessage).check(
    Schema.isMaxLength(sampleLimits.messages),
  ),
  excludedThreads: Schema.Int,
});
export type SamplePlan = typeof SamplePlan.Type;
type Candidate = SampleMessage & { threadIds: readonly string[] };

// Expand recent seeds into whole connected threads within the three source
// folders. Skip an entire thread if it would exceed the sample's bounds.
export const selectSample = (candidates: readonly Candidate[]) => {
  const parent = candidates.map((_, index) => index);
  const root = (index: number): number =>
    parent[index] === index ? index : (parent[index] = root(parent[index]!));
  const identities = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    for (const id of candidate.threadIds) {
      const existing = identities.get(id);
      if (existing !== undefined) parent[root(index)] = root(existing);
      identities.set(id, index);
    }
  });
  const groups = new Map<number, Candidate[]>();
  candidates.forEach((candidate, index) => {
    const key = root(index);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  });
  const recent = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        b.candidate.metadata.timestamp - a.candidate.metadata.timestamp ||
        b.candidate.metadata.source.uid - a.candidate.metadata.source.uid,
    );
  const selected = new Set<number>();
  const considered = new Set<number>();
  const counts = new Map<string, number>();
  let bytes = 0;
  let messages = 0;
  let excludedThreads = 0;
  for (const { candidate, index } of recent) {
    const mailbox = candidate.metadata.source.mailbox;
    if ((counts.get(mailbox) ?? 0) >= sampleLimits.perFolder) continue;
    const key = root(index);
    if (considered.has(key)) continue;
    considered.add(key);
    const group = groups.get(key)!;
    const size = group.reduce((sum, member) => sum + member.size, 0);
    if (
      messages + group.length > sampleLimits.messages ||
      bytes + size > sampleLimits.bytes ||
      group.some((member) => member.size > sampleLimits.messageBytes)
    ) {
      excludedThreads++;
      continue;
    }
    selected.add(key);
    bytes += size;
    messages += group.length;
    for (const member of group)
      counts.set(
        member.metadata.source.mailbox,
        (counts.get(member.metadata.source.mailbox) ?? 0) + 1,
      );
  }
  return {
    messages: candidates
      .filter((_, index) => selected.has(root(index)))
      .map(({ metadata, size }) => ({ metadata, size })),
    excludedThreads,
  };
};

type SourceClient = Pick<ImapFlow, "mailboxOpen" | "fetch" | "fetchOne">;
export const planSample = async (client: SourceClient, account: string) => {
  const candidates: Candidate[] = [];
  for (const mapping of sampleFolders) {
    const mailbox = await client.mailboxOpen(mapping.path, { readOnly: true });
    const uidValidity = Number(mailbox.uidValidity);
    if (
      !Number.isSafeInteger(uidValidity) ||
      !Number.isSafeInteger(mailbox.uidNext)
    )
      throw new MailSampleError("iCloud returned an invalid mailbox identity.");
    if (!mailbox.exists) continue;
    if (mailbox.uidNext <= 1)
      throw new MailSampleError(
        "iCloud returned an invalid mailbox UID range.",
      );
    for await (const message of client.fetch(
      `1:${mailbox.uidNext - 1}`,
      {
        uid: true,
        size: true,
        flags: true,
        internalDate: true,
        headers: ["message-id", "references", "in-reply-to"],
      },
      { uid: true },
    )) {
      if (!message.flags || !message.internalDate || !message.headers)
        throw new MailSampleError(
          "iCloud returned incomplete message metadata.",
        );
      const metadata = Schema.decodeUnknownSync(MailImportMetadata)({
        source: {
          account,
          mailbox: mapping.path,
          uidValidity,
          uid: message.uid,
        },
        folder: mapping.folder,
        archived: mapping.archived,
        timestamp: new Date(message.internalDate).getTime(),
        flags: [...message.flags],
      });
      const entry = Schema.decodeUnknownSync(SampleMessage)({
        metadata,
        size: message.size,
      });
      const headers =
        message.headers.byteLength > 2
          ? await parseRawHeaders(message.headers)
          : null;
      candidates.push({
        ...entry,
        threadIds: conversationMessageIds(
          (name) => headers?.headers.find(({ key }) => key === name)?.value,
        ),
      });
    }
  }
  return selectSample(candidates);
};

export type SampleSink = {
  completed(source: MailImportMetadata["source"]): Promise<string | null>;
  ingest(
    metadata: MailImportMetadata,
    raw: Uint8Array<ArrayBuffer>,
  ): Promise<{ status: "imported" | "skipped" | "failed"; id?: string }>;
};
export const runSample = async (
  client: SourceClient,
  sink: SampleSink,
  plan: SamplePlan,
  progress: (count: number, total: number) => void = () => {},
) => {
  const results: {
    mailbox: string;
    uid: number;
    status: string;
    id?: string;
  }[] = [];
  for (const mapping of sampleFolders) {
    const entries = plan.messages.filter(
      (entry) => entry.metadata.source.mailbox === mapping.path,
    );
    if (!entries.length) continue;
    const mailbox = await client.mailboxOpen(mapping.path, { readOnly: true });
    if (
      entries.some(
        (entry) =>
          String(entry.metadata.source.uidValidity) !==
          String(mailbox.uidValidity),
      )
    )
      throw new MailSampleError(
        "Mailbox UIDVALIDITY changed. Start a new sample plan after reviewing the source.",
      );
    for (const entry of entries) {
      const { source } = entry.metadata;
      const known = await sink.completed(source);
      if (known)
        results.push({
          mailbox: mapping.path,
          uid: source.uid,
          status: "skipped",
          id: known,
        });
      else {
        // ImapFlow builds BODY.PEEK[] for source requests. A partial limit also
        // bounds memory if the server's size differs from the saved inventory.
        const message = await client.fetchOne(
          String(source.uid),
          { uid: true, source: { maxLength: entry.size + 1 } },
          { uid: true },
        );
        if (
          !message ||
          message.uid !== source.uid ||
          !message.source ||
          message.source.byteLength !== entry.size
        )
          results.push({
            mailbox: mapping.path,
            uid: source.uid,
            status: "source-changed-or-missing",
          });
        else
          results.push({
            mailbox: mapping.path,
            uid: source.uid,
            ...(await sink.ingest(
              entry.metadata,
              new Uint8Array(message.source),
            )),
          });
      }
      progress(results.length, plan.messages.length);
    }
  }
  return {
    complete:
      results.length === plan.messages.length &&
      results.every(
        (entry) => entry.status === "imported" || entry.status === "skipped",
      ),
    results,
  };
};
