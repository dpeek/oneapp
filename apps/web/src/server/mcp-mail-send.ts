import type { McpServer } from "@modelcontextprotocol/server";
import { Effect, Schema } from "effect";
import type { WorkerEnv } from "../../../../alchemy.run.ts";
import {
  ComposeRecipient,
  InboxDraft,
  InboxMessageId,
  MailMessageId,
  ReplyCompletion,
  SentMessageId,
  mailMessageLink,
  replySubject,
} from "../inbox-contract.ts";
import { normalizePersonEmail } from "../people-contract.ts";
import { prepareMailBody } from "./mail-authoring.ts";
import {
  inboxSender,
  rejectedDelivery,
  sendDraft,
  sendRateLimitMessage,
  uncertainDelivery,
  type MailDelivery,
  type MailSenderBindings,
} from "./mail-delivery.ts";
import { readReplyTarget } from "./mail-reply-target.ts";
import { hiddenMail } from "./mail-trash.ts";
import {
  mailboxIdentities,
  mailboxSendAddress,
  mailboxSql,
  type scopeMailStore,
} from "./mailbox.ts";
import { result, runTool, standardSchema, toolFailure } from "./mcp-tool.ts";
import type { SentReply } from "./sent-mail.ts";

const requestFields = {
  requestId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u)),
  from: Schema.optionalKey(ComposeRecipient),
  text: InboxDraft.fields.text,
};
const Compose = Schema.Struct({
  ...requestFields,
  to: InboxDraft.fields.to,
  cc: InboxDraft.fields.cc,
  subject: InboxDraft.fields.subject,
});
const Reply = Schema.Struct({
  ...requestFields,
  messageId: MailMessageId,
  mode: Schema.Literals(["reply", "reply-all"]),
  completeThrough: Schema.optionalKey(InboxMessageId),
});
const SendResult = Schema.Struct({
  status: Schema.Literals(["sent", "uncertain"]),
  messageId: Schema.NullOr(SentMessageId),
  url: Schema.NullOr(Schema.String),
  completion: Schema.NullOr(ReplyCompletion),
  message: Schema.optionalKey(Schema.String),
});
const annotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};
const requestDescription =
  "Use a unique requestId (1–128 letters, digits, underscores, or hyphens) for each intended send. Reuse it verbatim to check the outcome of that send. If the outcome is uncertain, check Sent or verify delivery before attempting another send. Omit from to use the mailbox's configured sender.";

type MailStore = ReturnType<typeof scopeMailStore> &
  Pick<WorkerEnv, "INBOX_UPDATES"> &
  MailSenderBindings;

export const registerMailSendTools = (
  server: McpServer,
  origin: string,
  ownerId: string,
  ownedMailStore: () => Promise<MailStore>,
  defer: (work: Promise<unknown>) => void,
) => {
  const present = (delivery: MailDelivery) => {
    if (delivery.status === "rejected") return toolFailure(delivery.message);
    if (delivery.status === "uncertain")
      return result({
        status: "uncertain",
        messageId: null,
        url: null,
        completion: null,
        message:
          "Could not confirm whether the email was sent. Check Sent or verify delivery before attempting another send.",
      });
    const { messageId } = delivery;
    return result({
      ...delivery,
      url: messageId ? new URL(mailMessageLink(messageId), origin).href : null,
    });
  };

  const send = (args: typeof Compose.Type | typeof Reply.Type) =>
    runTool("Could not process the mail request.", async () => {
      const store = await ownedMailStore();
      const { DB } = store;
      const { from, requestId, text } = args;
      const requestedFrom =
        from === undefined ? null : normalizePersonEmail(from);
      const isReply = "messageId" in args;
      const payload = isReply
        ? [
            "reply",
            requestedFrom,
            args.messageId,
            args.mode,
            text,
            args.completeThrough ?? null,
          ]
        : [
            "compose",
            requestedFrom,
            args.to,
            args.cc ?? "",
            args.subject,
            text,
          ];
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(payload)),
      );
      const fingerprint = new Uint8Array(digest).toHex();
      const mailbox = mailboxSql(DB);
      const previous = () =>
        DB.prepare(
          `SELECT fingerprint, outcome FROM mail_send_requests WHERE mailbox_id = ${mailbox} AND request_id = ?`,
        )
          .bind(requestId)
          .first<{ fingerprint: string; outcome: string | null }>();
      const replay = (
        row: NonNullable<Awaited<ReturnType<typeof previous>>>,
      ) =>
        row.fingerprint !== fingerprint
          ? toolFailure(
              "This requestId was already used with different mail content.",
            )
          : present(
              row.outcome === null
                ? uncertainDelivery
                : (JSON.parse(row.outcome) as MailDelivery),
            );

      const existing = await previous();
      if (existing) return replay(existing);

      const identities = await mailboxIdentities(DB);
      const allowedFrom = mailboxSendAddress(
        store.INBOX_EMAIL_FROM,
        identities,
      );
      if (requestedFrom !== null && requestedFrom !== allowedFrom)
        return toolFailure(
          "This mailbox cannot send from the requested address.",
        );
      const sender = inboxSender({ ...store, INBOX_EMAIL_FROM: allowedFrom });
      if (!sender)
        return toolFailure("Sending is unavailable for this mailbox.");

      let draft: typeof InboxDraft.Type;
      let reply: SentReply | undefined;
      let completeThrough: string | undefined;
      if (isReply) {
        const { messageId, mode } = args;
        const target = (await hiddenMail(DB, messageId))
          ? null
          : await readReplyTarget(
              store,
              messageId,
              identities.map(({ address }) => address),
            );
        if (!target) return toolFailure("Mail message not found.");
        const decoded = Schema.decodeUnknownOption(InboxDraft)({
          to: mode === "reply-all" ? target.allTo : target.to,
          ...(mode === "reply-all" && target.cc ? { cc: target.cc } : {}),
          subject: replySubject(target.subject),
          text,
        });
        if (decoded._tag === "None")
          return toolFailure(
            "This email has no usable reply address within the form limits.",
          );
        draft = decoded.value;
        reply = {
          originalId: messageId,
          ...(target.headers ? { headers: target.headers } : {}),
        };
        completeThrough = args.completeThrough;
      } else {
        const { to, cc, subject } = args;
        draft = { to, ...(cc ? { cc } : {}), subject, text };
      }
      const body = prepareMailBody(draft);
      if (!body) return toolFailure("Enter a message within the form limits.");

      // A pending row is durable before calling the transport. A crash or
      // ambiguous provider response leaves it unsafe to dispatch again.
      const claimed = await DB.prepare(
        `INSERT INTO mail_send_requests (mailbox_id, request_id, fingerprint)
         VALUES (${mailbox}, ?, ?) ON CONFLICT (mailbox_id, request_id) DO NOTHING
         RETURNING request_id`,
      )
        .bind(requestId, fingerprint)
        .first();
      if (!claimed) {
        const concurrent = await previous();
        return concurrent ? replay(concurrent) : present(uncertainDelivery);
      }

      const work = (async () => {
        const allowed = await sender.limit
          .limit({ key: ownerId })
          .catch(() => null);
        const delivery =
          allowed === null
            ? rejectedDelivery(503, "Could not check the sending limit.")
            : allowed.success
              ? await Effect.runPromise(
                  sendDraft(
                    sender.binding,
                    store,
                    defer,
                    { ...draft, ...body, from: sender.from },
                    reply,
                    completeThrough,
                  ),
                ).catch(() => uncertainDelivery)
              : rejectedDelivery(429, sendRateLimitMessage);
        if (delivery.status !== "uncertain")
          await DB.prepare(
            `UPDATE mail_send_requests SET outcome = ? WHERE mailbox_id = ${mailbox} AND request_id = ?`,
          )
            .bind(JSON.stringify(delivery), requestId)
            .run()
            .catch(() => {
              console.warn("Could not record MCP mail delivery outcome");
            });
        return delivery;
      })();
      defer(work);
      return present(await work);
    });

  server.registerTool(
    "send_mail",
    {
      title: "Send a new email",
      description: `Send a plain-text email with a subject and comma-separated To and optional Cc addresses. Returns the Sent message ID and browser URL when the copy is available. ${requestDescription}`,
      inputSchema: standardSchema(Compose),
      outputSchema: standardSchema(SendResult),
      annotations,
    },
    send,
  );
  server.registerTool(
    "reply_mail",
    {
      title: "Reply to an email",
      description: `Send a plain-text reply to the source message. Use reply for its reply address or reply-all to include other To and Cc recipients. Supply completeThrough only when asked to mark the conversation done, using its latest incoming message ID. ${requestDescription}`,
      inputSchema: standardSchema(Reply),
      outputSchema: standardSchema(SendResult),
      annotations,
    },
    send,
  );
};
