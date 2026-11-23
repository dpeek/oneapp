import { mailboxSql, type MailDatabase } from "./mailbox.ts";
import type {
  R2Object,
  R2Bucket,
  R2Objects,
  RateLimit,
  SendEmail,
} from "@cloudflare/workers-types";
import { ByteSize, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { compile } from "html-to-text";
import PostalMime, { decodeWords, type Email } from "postal-mime";
import type { WorkerEnv } from "../../../../alchemy.run.ts";
import {
  allMailApiPath,
  trashApiPath,
  archiveApiPath,
  Conversation,
  ConversationArchiveUpdate,
  ConversationPage,
  conversationsApiPath,
  folderApiPath,
  inboxApiPath,
  InboxDraft,
  DeletedMailCursor,
  splitRecipients,
  InboxEntry,
  InboxMessageId,
  InboxPage,
  InboxReadUpdate,
  InboxSend,
  inboxSendPath,
  InboxUnread,
  inboxUnreadPath,
  InlineReply,
  type MailFolder,
  MailMessageId,
  noiseApiPath,
  NoiseSenders,
  noiseSendersApiPath,
  type ReplyCompletion,
  replyCompletionHeader,
  replySubject,
  SentEntry,
  SentPage,
  senderRuleApiPath,
  senderAppearanceApiPath,
  SenderAppearanceUpdate,
  SenderRule,
  sentCopyHeader,
  sentMessageHeader,
} from "../inbox-contract.ts";
import {
  hiddenMail,
  recoverableMail,
  visibleMail,
  trashMail,
  restoreMail,
  listTrash,
} from "./mail-trash.ts";
import { mailPreview } from "./mail-preview.ts";
import { jsonError, privateHeaders } from "./api-response.ts";
import { AppAuth, ownerId, type authHttp } from "./auth.ts";
import {
  indexMail,
  isMailingList,
  inboxMessageUnread,
  conversationCursor,
  inboxUnread,
  listConversations,
  readNoiseSenders,
  readThread,
  scanMail,
  setInboxUnread,
  setSenderRule,
  setThreadArchived,
} from "./mail-index.ts";
import {
  attachmentResponse,
  describeAttachments,
  mailMimeOptions as mimeOptions,
  receivedMessageLimit,
} from "./mail-attachments.ts";
import { mailHtmlPreview, type MailImageOptions } from "./mail-html-preview.ts";
import { prepareMailBody } from "./mail-authoring.ts";
import {
  conversationMessageIds,
  parentMessageId,
  replyHeaders,
  replyRecipient,
  replyAllRecipients,
} from "./mail-reply.ts";
import {
  setSenderAppearance,
  withSenderAppearances,
} from "./mail-sender-appearance.ts";
import { mailPeople } from "./mail-people.ts";
import {
  describeRawMail,
  describeStoredRawMail,
  rawMailFormat,
  storedMailTimestamp,
} from "./raw-mail.ts";
import { normalizePersonEmail } from "../people-contract.ts";
import { managedPersonAddresses, matchPeople } from "./people-store.ts";
import {
  describeSent,
  describeStoredSent,
  isSentMessageId,
  listSent,
  readSent,
  readSentReplyTarget,
  saveSent,
  type SentReply,
} from "./sent-mail.ts";

type InboxEnv = Pick<
  WorkerEnv,
  | "APP_ORIGIN"
  | "INBOX_EMAIL_ADDRESS"
  | "INBOX_MESSAGES"
  | "INBOX_EMAIL_FROM"
  | "INBOX_UPDATES"
  | "SENT_MESSAGES"
> & {
  DB: MailDatabase;
  mailboxAddresses: readonly string[];
  INBOX_SEND?: SendEmail;
  INBOX_SEND_LIMIT?: RateLimit;
};
type InboxBucket = InboxEnv["INBOX_MESSAGES"];

export const notifyInbox = async ({
  INBOX_UPDATES,
  DB,
}: Pick<WorkerEnv, "INBOX_UPDATES"> & { DB: MailDatabase }) => {
  if (!INBOX_UPDATES) return;
  try {
    await INBOX_UPDATES.getByName(DB.mailboxId).publish();
  } catch {
    console.warn("Could not notify Inbox subscribers");
  }
};

export const inboxSessionHeaders = {
  id: "x-oneapp-inbox-session-id",
  revision: "x-oneapp-inbox-security-revision",
  mailbox: "x-oneapp-inbox-mailbox",
};

export type InboxSocketSession = {
  sessionId: string;
  securityRevision: string;
  mailboxId: string;
};

const isInboxMessageId = Schema.is(InboxMessageId);
const isMailMessageId = Schema.is(MailMessageId);
const headerLimit = 64 * 1024;
const textLimit = 256 * 1024;
const htmlLimit = 1024 * 1024;
const bodyPreviewReadLimit = 128 * 1024;
const htmlToText = compile({
  wordwrap: false,
  limits: { maxDepth: 48 },
  selectors: [
    { selector: ".gmail_quote", format: "blockquote" },
    { selector: ".yahoo_quoted", format: "blockquote" },
    { selector: "img", format: "skip" },
    { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
    { selector: "script", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "svg", format: "skip" },
  ],
});

const readableMessage = (email: Email) => {
  const html = email.text?.trim() ? "" : (email.html ?? "");
  return {
    html,
    text: html ? htmlToText(html.slice(0, htmlLimit)) : (email.text ?? ""),
  };
};

const readBodyPreview = async (env: InboxEnv, id: string) => {
  if (isSentMessageId(id)) {
    const entry = await readSent(env.SENT_MESSAGES, id);
    return entry ? mailPreview(entry) : undefined;
  }
  // The body usually precedes attachments. A ranged read bounds list work.
  const object = await env.INBOX_MESSAGES.get(id, {
    range: { offset: 0, length: bodyPreviewReadLimit },
  });
  if (!object) return;
  const bytes = await object.arrayBuffer();
  const email = await PostalMime.parse(bytes, mimeOptions).catch(() => null);
  return email ? mailPreview(email) : "";
};

const withBodyPreviews = async <
  Message extends { id: string; lastMessageId?: string },
>(
  env: InboxEnv,
  messages: ReadonlyArray<Message>,
) => {
  if (!messages.length) return [];
  const previewId = (message: Message) => message.lastMessageId ?? message.id;
  const ids = [...new Set(messages.map(previewId))];
  const { results }: { results: { id: string; bodyPreview: string }[] } =
    await env.DB.prepare(
      `SELECT id, body_preview AS bodyPreview FROM mail_index_messages
     WHERE mailbox_id = ${mailboxSql(env.DB)} AND deleted = 0 AND body_preview IS NOT NULL
       AND id IN (SELECT value FROM json_each(?))`,
    )
      .bind(JSON.stringify(ids))
      .all<{ id: string; bodyPreview: string }>();
  const previews = new Map(
    results.map(({ id, bodyPreview }) => [id, bodyPreview]),
  );
  const missing = ids.filter((id) => !previews.has(id));
  const loaded = await Effect.runPromise(
    Effect.forEach(
      missing,
      (id) =>
        Effect.promise(
          async () =>
            [
              id,
              await readBodyPreview(env, id).catch(() => undefined),
            ] as const,
        ),
      { concurrency: 4 },
    ),
  );
  const updates = loaded.flatMap(([id, bodyPreview]) => {
    if (bodyPreview === undefined) return [];
    previews.set(id, bodyPreview);
    return [
      env.DB.prepare(
        `UPDATE mail_index_messages SET body_preview = ?
         WHERE mailbox_id = ${mailboxSql(env.DB)} AND id = ? AND deleted = 0 AND body_preview IS NULL`,
      ).bind(bodyPreview, id),
    ];
  });
  for (let start = 0; start < updates.length; start += 20)
    await env.DB.batch(updates.slice(start, start + 20));
  return messages.map((message) => {
    const bodyPreview = previews.get(previewId(message));
    return bodyPreview ? { ...message, bodyPreview } : message;
  });
};

// R2 lists keys in ascending order, so new messages sort newest first.
const newestFirstKey = (date: number) => {
  const time = String(9_999_999_999_999 - date).padStart(13, "0");
  return `0-${time}-${crypto.randomUUID()}`;
};

export const inboxMessageKey = () => `${newestFirstKey(Date.now())}.eml`;

export const inboxSubject = (header: string | null) =>
  decodeWords(header?.slice(0, 4096) ?? "")
    .trim()
    .slice(0, 200);

const summary = (object: R2Object, subject: string) => ({
  id: object.key,
  receivedAt: storedMailTimestamp(object),
  from: object.customMetadata?.envelopeFrom ?? "",
  subject,
});

const readHeaders = async (bucket: InboxBucket, id: string, length: number) => {
  const object = await bucket.get(id, { range: { offset: 0, length } });
  if (!object) return null;
  const raw = await object.text();
  const boundary = raw.search(/\r\n\r\n|\n\n|\r\r/u);
  try {
    const email = await PostalMime.parse(
      (boundary < 0 ? raw : raw.slice(0, boundary)) + "\r\n\r\n",
      mimeOptions,
    );
    return { email, metadata: object.customMetadata };
  } catch {
    return { email: null, metadata: object.customMetadata };
  }
};

const readSubject = async (bucket: InboxBucket, object: R2Object) => {
  if (object.customMetadata?.subject !== undefined)
    return object.customMetadata.subject;
  // Messages saved before subjects were indexed only need a header-sized read.
  if (!object.size) return "";
  const headers = await readHeaders(
    bucket,
    object.key,
    Math.min(object.size, headerLimit),
  );
  return headers?.email?.subject?.trim().slice(0, 200) ?? "";
};

const describeStoredInbox = async (bucket: InboxBucket, object: R2Object) => {
  if (!isInboxMessageId(object.key) || !object.size) return null;
  if (object.customMetadata?.format === rawMailFormat)
    return describeStoredRawMail(bucket, object, "inbox");
  const headers = await readHeaders(
    bucket,
    object.key,
    Math.min(object.size, mimeOptions.maxHeadersSize),
  );
  if (!headers) return null;
  const { email } = headers;
  const from =
    object.customMetadata?.envelopeFrom ?? email?.from?.address ?? "";
  const to = object.customMetadata?.envelopeTo ?? "";
  return {
    id: object.key,
    folder: "inbox" as const,
    timestamp: object.uploaded.getTime(),
    unread: object.customMetadata?.initialUnread === "1",
    from,
    to,
    envelopeRecipient: object.customMetadata?.envelopeTo,
    people: describePeople(email, from, to),
    listMail: isMailingList(
      email?.headers.find(({ key }) => key === "list-id")?.value,
    ),
    subject:
      object.customMetadata?.subject ??
      email?.subject?.trim().slice(0, 200) ??
      "",
    messageIds: conversationMessageIds(
      (name) => email?.headers.find(({ key }) => key === name)?.value,
    ),
  };
};

const describePeople = (email: Email | null, from: string, to: string) =>
  mailPeople(
    (name) =>
      email?.headers
        .filter(({ key }) => key === name)
        .map(({ value }) => value)
        .join(", "),
    from,
    to,
  );

export const syncMailIndex = async (env: InboxEnv, reconcile = false) => {
  const inbox = await scanMail(
    env.DB,
    "inbox",
    env.INBOX_MESSAGES,
    (object) => describeStoredInbox(env.INBOX_MESSAGES, object),
    reconcile,
  );
  const sent = await scanMail(
    env.DB,
    "sent",
    env.SENT_MESSAGES,
    (object) => describeStoredSent(env.SENT_MESSAGES, object),
    reconcile,
  );
  return inbox || sent;
};

const loadConversation = async (env: InboxEnv, id: string) => {
  const thread = await readThread(env.DB, id);
  if (thread.messages.some((message) => message.id === id)) return thread;
  const inbox = isInboxMessageId(id);
  const bucket = inbox ? env.INBOX_MESSAGES : env.SENT_MESSAGES;
  const object = await bucket.head(id);
  if (!object) return thread;
  const mail = inbox
    ? await describeStoredInbox(bucket, object)
    : await describeStoredSent(bucket, object);
  if (!mail) return thread;
  await indexMail(env.DB, mail);
  return readThread(env.DB, id);
};

const profilesFor = async (env: InboxEnv, addresses: string[]) =>
  addresses.length
    ? matchPeople(
        env.DB,
        addresses,
        await managedPersonAddresses(env.DB, env.INBOX_EMAIL_ADDRESS),
      )
    : [];

const replyInfo = (
  email: Email | null,
  envelopeFrom: string,
  env: InboxEnv,
  envelopeRecipient?: string,
) => {
  const to = email && replyRecipient(email, envelopeFrom);
  return to && email
    ? {
        reply: {
          to,
          ...replyAllRecipients(email, envelopeFrom, [
            ...env.mailboxAddresses,
            ...(envelopeRecipient ? [envelopeRecipient] : []),
          ]),
          threaded: parentMessageId(email) !== undefined,
        },
      }
    : {};
};

const inboxSender = (env: InboxEnv) => {
  const {
    INBOX_EMAIL_FROM: from,
    INBOX_SEND: binding,
    INBOX_SEND_LIMIT: limit,
  } = env;
  return from && binding && limit ? { from, binding, limit } : null;
};

const listMessages = async (env: InboxEnv, cursor: string | undefined) => {
  const bucket = env.INBOX_MESSAGES;
  const page: R2Objects = await bucket.list({
    limit: 20,
    cursor,
    include: ["customMetadata"],
  });
  return {
    messages: await visibleMail(
      env.DB,
      await Promise.all(
        page.objects
          .filter(({ key }) => isInboxMessageId(key))
          .map(async (object) => {
            if (object.customMetadata?.format === rawMailFormat) {
              const mail = await describeStoredRawMail(bucket, object, "inbox");
              if (mail)
                return { ...summary(object, mail.subject), from: mail.from };
            }
            return summary(object, await readSubject(bucket, object));
          }),
      ),
    ),
    cursor: page.truncated ? page.cursor : null,
  };
};

const readMessage = async (
  env: InboxEnv,
  id: string,
  images: MailImageOptions,
): Promise<typeof InboxEntry.Type | null> => {
  const bucket = env.INBOX_MESSAGES;
  const object = await bucket.get(id);
  if (!object) return null;
  const unread =
    (await inboxMessageUnread(env.DB, id)) ??
    object.customMetadata?.initialUnread === "1";
  const imported = object.customMetadata?.format === rawMailFormat;
  const to =
    object.customMetadata?.envelopeTo ??
    (imported ? "" : env.INBOX_EMAIL_ADDRESS) ??
    "";
  const envelopeFrom = object.customMetadata?.envelopeFrom ?? "";
  const fallback = async (preview: "tooLarge" | "unreadable") => {
    const length = Math.min(object.size, mimeOptions.maxHeadersSize);
    const headers = length ? await readHeaders(bucket, id, length) : null;
    const subject =
      object.customMetadata?.subject ??
      headers?.email?.subject?.trim().slice(0, 200) ??
      "";
    const mail =
      imported && headers?.email
        ? describeRawMail(object, headers.email, "inbox")
        : null;
    return {
      ...summary(object, subject),
      ...(mail ? { from: mail.from } : {}),
      ...replyInfo(
        headers?.email ?? null,
        envelopeFrom,
        env,
        object.customMetadata?.envelopeTo,
      ),
      people: describePeople(headers?.email ?? null, envelopeFrom, to),
      to: mail?.to ?? to,
      unread,
      text: "",
      preview,
    };
  };
  if (object.size > receivedMessageLimit) {
    await object.body.cancel();
    return fallback("tooLarge");
  }

  const bytes = await object.arrayBuffer();
  try {
    const email = await PostalMime.parse(bytes, mimeOptions);
    const { text } = readableMessage(email);
    const html = email.html ?? "";
    const from = email.from?.address;
    const attachments = describeAttachments(email.attachments);
    return {
      ...summary(object, email.subject?.trim().slice(0, 200) ?? ""),
      ...replyInfo(email, envelopeFrom, env, object.customMetadata?.envelopeTo),
      people: describePeople(email, envelopeFrom, to),
      from: from
        ? email.from?.name
          ? `${email.from.name} <${from}>`
          : from
        : envelopeFrom,
      to: imported ? describeRawMail(object, email, "inbox").to : to,
      unread,
      ...(attachments.length ? { attachments } : {}),
      text: text.slice(0, textLimit),
      ...(html && html.length <= htmlLimit
        ? await mailHtmlPreview(html, email.attachments, images)
        : {}),
      preview:
        html.length > htmlLimit || text.length > textLimit
          ? "truncated"
          : "complete",
    };
  } catch {
    return fallback("unreadable");
  }
};

const downloadOriginal = async (bucket: InboxBucket, id: string) => {
  const object = await bucket.get(id);
  if (!object) return null;
  return HttpServerResponse.fromWeb(
    new Response(object.body, {
      headers: {
        ...privateHeaders,
        "content-type": "application/octet-stream",
        "content-length": String(object.size),
        "content-disposition": `attachment; filename="${id}"`,
        "x-content-type-options": "nosniff",
      },
    }),
  );
};

const requireInboxOwner = Effect.gen(function* () {
  const auth = yield* AppAuth;
  const session = yield* auth.requireSession;
  return session.subjectId === ownerId;
});

const inboxErrors = {
  AuthenticationRequired: () => jsonError(401, "Sign in required"),
  UnknownError: () => jsonError(503, "Could not load your mail. Try again."),
};

const notFound = () => jsonError(404, "Message not found");
const listQuery = HttpServerRequest.schemaSearchParams(
  Schema.Struct({
    cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  }),
);

const unknownSend = () =>
  jsonError(502, "Could not confirm whether the email was sent.");
const sendRateLimit = () =>
  jsonError(429, "Sending limit reached. Try again later.");

const isJsonRequest = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request) =>
    request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json",
);

const sendDraft = Effect.fnUntraced(function* (
  binding: SendEmail,
  env: InboxEnv,
  defer: (work: Promise<unknown>) => void,
  message: typeof InboxDraft.Type & { from: string },
  reply: SentReply | undefined,
  completeThrough: string | undefined,
) {
  const { attachments, cc, ...body } = message;
  const sent = yield* Effect.tryPromise({
    try: () =>
      binding.send({
        ...body,
        to: message.to.includes(",") ? splitRecipients(message.to) : message.to,
        ...(cc ? { cc: splitRecipients(cc) } : {}),
        ...(attachments
          ? {
              attachments: attachments.map((file) => ({
                ...file,
                disposition: "attachment" as const,
                content: Uint8Array.fromBase64(file.content),
              })),
            }
          : {}),
        ...(reply?.headers ? { headers: reply.headers } : {}),
      }),
    catch: (error) =>
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined,
  }).pipe(Effect.result);
  if (sent._tag === "Success") {
    if (!sent.success?.messageId) return yield* unknownSend();
    const sentAt = Date.now();
    const record = {
      ...message,
      id: newestFirstKey(sentAt),
      sentAt,
      providerMessageId: sent.success.messageId,
      ...(reply ? { reply } : {}),
    };
    const saved = yield* saveSent(env.SENT_MESSAGES, record);
    if (saved)
      yield* Effect.promise(() =>
        indexMail(env.DB, describeSent(record)).catch(() => {
          console.warn("Could not index sent email");
        }),
      );
    let completion: typeof ReplyCompletion.Type | undefined;
    if (reply && completeThrough) {
      const result = yield* Effect.promise(() =>
        setThreadArchived(
          env.DB,
          completeThrough,
          true,
          reply.originalId,
        ).catch(() => {
          console.warn("Could not mark replied conversation done");
          return "missing" as const;
        }),
      );
      completion =
        result === "stale"
          ? "new-mail"
          : result === "missing"
            ? "failed"
            : "done";
    }
    if (saved || completion === "done") defer(notifyInbox(env));
    return HttpServerResponse.empty({
      status: 204,
      headers: {
        ...privateHeaders,
        ...(saved
          ? { [sentMessageHeader]: record.id }
          : { [sentCopyHeader]: "failed" }),
        ...(completion ? { [replyCompletionHeader]: completion } : {}),
      },
    });
  }
  switch (sent.failure) {
    case "E_VALIDATION_ERROR":
      return yield* jsonError(400, "Cloudflare rejected the email format.");
    case "E_RECIPIENT_SUPPRESSED":
      return yield* jsonError(
        422,
        "Cloudflare has suppressed this recipient address.",
      );
    case "E_RECIPIENT_NOT_ALLOWED":
    case "E_RECIPIENT_PLAN_RESTRICTED":
      return yield* jsonError(
        422,
        "Cloudflare does not allow sending to this address.",
      );
    case "E_DELIVERY_FAILED":
      return yield* jsonError(
        422,
        "Cloudflare could not deliver the email to this address.",
      );
    case "E_RATE_LIMIT_EXCEEDED":
    case "E_DAILY_LIMIT_EXCEEDED":
      return yield* sendRateLimit();
    default:
      return yield* unknownSend();
  }
}, Effect.withTracerEnabled(false));

const deliverMail = Effect.fnUntraced(function* (
  env: InboxEnv,
  defer: (work: Promise<unknown>) => void,
  sender: NonNullable<ReturnType<typeof inboxSender>>,
  message: typeof InboxDraft.Type,
  reply: SentReply | undefined,
  completeThrough?: string,
) {
  const body = prepareMailBody(message);
  if (!body)
    return yield* jsonError(400, "Enter a message within the form limits.");
  const work = Effect.runPromiseExit(
    sendDraft(
      sender.binding,
      env,
      defer,
      { ...message, ...body, from: sender.from },
      reply,
      completeThrough,
    ),
  );
  // Keep the send and its archive write together if the client disconnects.
  defer(work);
  const result = yield* Effect.promise(() => work);
  return yield* result;
});

const sendEmail = (env: InboxEnv, defer: (work: Promise<unknown>) => void) =>
  Effect.gen(function* () {
    const sender = inboxSender(env);
    if (!sender)
      return yield* jsonError(503, "Sending is unavailable for this mailbox.");
    if (!(yield* isJsonRequest))
      return yield* jsonError(415, "Expected a JSON request");

    const draft = yield* HttpServerRequest.schemaBodyJson(InboxSend, {
      onExcessProperty: "error",
    }).pipe(
      Effect.provideService(
        HttpServerRequest.MaxBodySize,
        ByteSize.mebibytes(15),
      ),
      Effect.option,
    );
    if (draft._tag === "None")
      return yield* jsonError(
        400,
        "Enter valid recipients, a subject, and a message within the form limits.",
      );
    if (
      !(yield* Effect.tryPromise(() => sender.limit.limit({ key: ownerId })))
        .success
    )
      return yield* sendRateLimit();

    const { replyToId, ...message } = draft.value;
    if (
      replyToId &&
      (yield* Effect.tryPromise(() => hiddenMail(env.DB, replyToId)))
    )
      return yield* notFound();
    let reply: SentReply | undefined;
    if (replyToId) {
      const original = yield* Effect.tryPromise(() =>
        readHeaders(env.INBOX_MESSAGES, replyToId, mimeOptions.maxHeadersSize),
      );
      if (!original)
        return yield* jsonError(
          404,
          "The original email is no longer in Inbox.",
        );
      const headers = original.email ? replyHeaders(original.email) : undefined;
      reply = { originalId: replyToId, ...(headers ? { headers } : {}) };
    }
    return yield* deliverMail(env, defer, sender, message, reply, replyToId);
  });

const readReplyTarget = async (env: InboxEnv, id: string) => {
  if (isSentMessageId(id)) return readSentReplyTarget(env.SENT_MESSAGES, id);
  const original = await readHeaders(
    env.INBOX_MESSAGES,
    id,
    mimeOptions.maxHeadersSize,
  );
  if (!original) return null;
  return {
    to: replyRecipient(original.email, original.metadata?.envelopeFrom ?? ""),
    subject: original.email?.subject ?? original.metadata?.subject ?? "",
    headers: original.email ? replyHeaders(original.email) : undefined,
  };
};

const sendInlineReply = (
  env: InboxEnv,
  defer: (work: Promise<unknown>) => void,
) =>
  Effect.gen(function* () {
    const sender = inboxSender(env);
    if (!sender)
      return yield* jsonError(503, "Sending is unavailable for this mailbox.");
    const { id } = yield* HttpRouter.params;
    if (!isMailMessageId(id)) return yield* notFound();
    if (!(yield* isJsonRequest))
      return yield* jsonError(415, "Expected a JSON request");
    const body = yield* HttpServerRequest.schemaBodyJson(InlineReply, {
      onExcessProperty: "error",
    }).pipe(
      Effect.provideService(
        HttpServerRequest.MaxBodySize,
        ByteSize.kibibytes(256),
      ),
      Effect.option,
    );
    if (body._tag === "None")
      return yield* jsonError(400, "Enter a reply within the form limits.");
    if (
      !(yield* Effect.tryPromise(() => sender.limit.limit({ key: ownerId })))
        .success
    )
      return yield* sendRateLimit();

    if (yield* Effect.tryPromise(() => hiddenMail(env.DB, id)))
      return yield* notFound();
    const target = yield* Effect.tryPromise(() => readReplyTarget(env, id));
    if (!target) return yield* notFound();
    const draft = Schema.decodeUnknownOption(InboxDraft)({
      to: target.to,
      subject: replySubject(target.subject),
      text: body.value.text,
      ...(body.value.html !== undefined ? { html: body.value.html } : {}),
    });
    if (draft._tag === "None")
      return yield* jsonError(422, "This email has no usable reply address.");
    return yield* deliverMail(
      env,
      defer,
      sender,
      draft.value,
      {
        originalId: id,
        ...(target.headers ? { headers: target.headers } : {}),
      },
      isInboxMessageId(id) ? id : body.value.completeThrough,
    );
  });

export const inboxRoutes = (
  http: ReturnType<typeof authHttp>,
  env: InboxEnv,
  defer: (work: Promise<unknown>) => void,
) => {
  const list = (folder: MailFolder) =>
    Effect.gen(function* () {
      if (!(yield* requireInboxOwner))
        return yield* jsonError(403, "Access denied");
      const query = yield* listQuery.pipe(Effect.option);
      if (query._tag === "None")
        return yield* jsonError(400, "Invalid page cursor");
      const sender = inboxSender(env);
      const mailbox = {
        address: env.INBOX_EMAIL_ADDRESS ?? null,
        ...(sender ? { sender: sender.from } : {}),
      };
      if (folder === "sent") {
        const indexing = yield* Effect.tryPromise(() => syncMailIndex(env));
        const page = yield* Effect.tryPromise(async () => {
          const page = await listSent(env.SENT_MESSAGES, query.value.cursor);
          return {
            ...page,
            messages: await withBodyPreviews(
              env,
              await visibleMail(env.DB, page.messages),
            ),
          };
        });
        return yield* HttpServerResponse.schemaJson(SentPage)(
          { ...page, ...mailbox, ...(indexing ? { indexing } : {}) },
          { headers: privateHeaders },
        );
      }
      const page = yield* Effect.tryPromise(() =>
        listMessages(env, query.value.cursor),
      );
      return yield* HttpServerResponse.schemaJson(InboxPage)(
        { ...page, ...mailbox },
        { headers: privateHeaders },
      );
    }).pipe(Effect.catchTags(inboxErrors));

  const read = (folder: MailFolder | "trash", original = false) =>
    Effect.gen(function* () {
      if (!(yield* requireInboxOwner))
        return yield* jsonError(403, "Access denied");
      const query = yield* HttpServerRequest.schemaSearchParams(
        Schema.Struct({
          images: Schema.optionalKey(Schema.Literals(["safe", "all"])),
        }),
      ).pipe(Effect.option);
      if (query._tag === "None")
        return yield* jsonError(400, "Invalid image mode");
      if (
        query.value.images &&
        (yield* HttpServerRequest.HttpServerRequest).headers[
          "x-effect-auth-csrf"
        ] !== "1"
      )
        return yield* jsonError(403, "Image loading requires an app request");
      const images: MailImageOptions = {
        origin: env.APP_ORIGIN,
        mode: query.value.images,
      };
      const { id } = yield* HttpRouter.params;
      const available = yield* Effect.tryPromise(async () =>
        folder === "trash"
          ? recoverableMail(env.DB, id ?? "")
          : !(await hiddenMail(env.DB, id ?? "")),
      );
      if (!available) return yield* notFound();
      const storageFolder =
        folder === "trash" ? (isSentMessageId(id) ? "sent" : "inbox") : folder;
      if (storageFolder === "sent") {
        if (!isSentMessageId(id)) return yield* notFound();
        const message = yield* Effect.tryPromise(() =>
          readSent(env.SENT_MESSAGES, id, images),
        );
        return message
          ? yield* HttpServerResponse.schemaJson(SentEntry)(
              (yield* Effect.tryPromise(() =>
                withSenderAppearances(env.DB, [message]),
              ))[0]!,
              {
                headers: privateHeaders,
              },
            )
          : yield* notFound();
      }
      if (!isInboxMessageId(id)) return yield* notFound();
      if (original) {
        const file = yield* Effect.tryPromise(() =>
          downloadOriginal(env.INBOX_MESSAGES, id),
        );
        return file ?? (yield* notFound());
      }
      const message = yield* Effect.tryPromise(() =>
        readMessage(env, id, images),
      );
      return message
        ? yield* HttpServerResponse.schemaJson(InboxEntry)(
            (yield* Effect.tryPromise(() =>
              withSenderAppearances(env.DB, [message]),
            ))[0]!,
            {
              headers: privateHeaders,
            },
          )
        : yield* notFound();
    }).pipe(Effect.catchTags(inboxErrors));

  const remove = (folder: MailFolder) => {
    const bucket: R2Bucket =
      folder === "sent" ? env.SENT_MESSAGES : env.INBOX_MESSAGES;
    const validId = folder === "sent" ? isSentMessageId : isInboxMessageId;
    const deleteMessage = Effect.gen(function* () {
      const { id } = yield* HttpRouter.params;
      if (!validId(id)) return yield* notFound();
      if (yield* Effect.tryPromise(() => hiddenMail(env.DB, id)))
        return HttpServerResponse.empty({
          status: 204,
          headers: privateHeaders,
        });
      const indexed = yield* Effect.tryPromise(() =>
        env.DB.prepare(
          `SELECT id FROM mail_index_messages WHERE mailbox_id = ${mailboxSql(env.DB)} AND id = ?`,
        )
          .bind(id)
          .first(),
      );
      if (!indexed) {
        const object = yield* Effect.tryPromise(() => bucket.head(id));
        if (!object) return yield* notFound();
        const mail = yield* Effect.tryPromise(() =>
          folder === "sent"
            ? describeStoredSent(bucket, object)
            : describeStoredInbox(bucket, object),
        );
        yield* Effect.tryPromise(() =>
          indexMail(
            env.DB,
            mail ?? {
              id,
              folder,
              from:
                object.customMetadata?.envelopeFrom ??
                object.customMetadata?.from ??
                "",
              to:
                object.customMetadata?.envelopeTo ??
                object.customMetadata?.to ??
                "",
              subject: object.customMetadata?.subject ?? "",
              timestamp: storedMailTimestamp(object),
              messageIds: [],
            },
          ),
        );
      }
      yield* Effect.tryPromise(() => trashMail(env.DB, id));
      yield* Effect.sync(() => defer(notifyInbox(env)));
      return HttpServerResponse.empty({ status: 204, headers: privateHeaders });
    });
    return Effect.gen(function* () {
      if (!(yield* requireInboxOwner))
        return yield* jsonError(403, "Access denied");
      return yield* http.protect(deleteMessage);
    }).pipe(
      Effect.catchTags({
        ...inboxErrors,
        HookDenied: () => jsonError(403, "Request not allowed"),
        UnknownError: () =>
          jsonError(503, "Could not delete this email. Try again."),
      }),
    );
  };

  const readAttachment = (preview: boolean) =>
    Effect.gen(function* () {
      if (!(yield* requireInboxOwner))
        return yield* jsonError(403, "Access denied");
      const { id, part } = yield* HttpRouter.params;
      if (
        !isMailMessageId(id) ||
        typeof part !== "string" ||
        !/^(?:0|[1-9]\d{0,2})$/u.test(part)
      )
        return yield* notFound();
      const query = yield* HttpServerRequest.schemaSearchParams(
        Schema.Struct({ trash: Schema.optionalKey(Schema.Literal("1")) }),
      ).pipe(Effect.option);
      if (query._tag === "None")
        return yield* jsonError(400, "Invalid mailbox");
      const available = yield* Effect.tryPromise(async () =>
        query.value.trash
          ? recoverableMail(env.DB, id)
          : !(await hiddenMail(env.DB, id)),
      );
      if (!available) return yield* notFound();
      const position = Number(part);
      if (position >= mimeOptions.maxPartCount) return yield* notFound();
      const response = yield* Effect.tryPromise(() =>
        attachmentResponse(
          isSentMessageId(id) ? env.SENT_MESSAGES : env.INBOX_MESSAGES,
          id,
          position,
          preview,
        ),
      );
      return response
        ? HttpServerResponse.fromWeb(response)
        : yield* notFound();
    }).pipe(Effect.catchTags(inboxErrors));

  const updateReadStatus = Effect.gen(function* () {
    const { id } = yield* HttpRouter.params;
    if (!isInboxMessageId(id)) return yield* notFound();
    const body = yield* HttpServerRequest.schemaBodyJson(InboxReadUpdate, {
      onExcessProperty: "error",
    }).pipe(
      Effect.provideService(
        HttpServerRequest.MaxBodySize,
        ByteSize.kibibytes(1),
      ),
      Effect.option,
    );
    if (body._tag === "None")
      return yield* jsonError(400, "Invalid read status");
    const { unread } = body.value;
    const result = yield* Effect.tryPromise(async () => {
      const updated = await setInboxUnread(env.DB, id, unread);
      if (updated !== "missing") return updated;
      const thread = await loadConversation(env, id);
      return thread.messages.some((message) => message.id === id)
        ? setInboxUnread(env.DB, id, unread)
        : "missing";
    });
    if (result === "missing") return yield* notFound();
    if (result === "changed") yield* Effect.sync(() => defer(notifyInbox(env)));
    return HttpServerResponse.empty({ status: 204, headers: privateHeaders });
  });

  const updateArchive = Effect.gen(function* () {
    const { id } = yield* HttpRouter.params;
    if (!isInboxMessageId(id)) return yield* notFound();
    const body = yield* HttpServerRequest.schemaBodyJson(
      ConversationArchiveUpdate,
      {
        onExcessProperty: "error",
      },
    ).pipe(
      Effect.provideService(
        HttpServerRequest.MaxBodySize,
        ByteSize.kibibytes(1),
      ),
      Effect.option,
    );
    if (body._tag === "None")
      return yield* jsonError(400, "Invalid archive status");
    const result = yield* Effect.tryPromise(() =>
      setThreadArchived(env.DB, id, body.value.archived),
    );
    if (result === "missing") return yield* notFound();
    if (result === "stale")
      return yield* jsonError(
        409,
        "A new reply arrived. Review it before archiving.",
      );
    if (result === "changed") yield* Effect.sync(() => defer(notifyInbox(env)));
    return HttpServerResponse.empty({ status: 204, headers: privateHeaders });
  });

  const recover = Effect.gen(function* () {
    const { id } = yield* HttpRouter.params;
    if (!isMailMessageId(id)) return yield* notFound();
    const restored = yield* Effect.tryPromise(() => restoreMail(env.DB, id));
    if (!restored) return yield* notFound();
    defer(notifyInbox(env));
    return HttpServerResponse.empty({ status: 204, headers: privateHeaders });
  });
  const recoveryRoutes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      `${inboxApiPath}/trash`,
      Effect.gen(function* () {
        if (!(yield* requireInboxOwner))
          return yield* jsonError(403, "Access denied");
        const query = yield* listQuery.pipe(Effect.option);
        if (query._tag === "None")
          return yield* jsonError(400, "Invalid page cursor");
        let cursor: typeof DeletedMailCursor.Type | undefined;
        if (query.value.cursor) {
          const decoded = yield* Effect.try(() =>
            Schema.decodeUnknownSync(DeletedMailCursor)(
              JSON.parse(query.value.cursor!),
            ),
          ).pipe(Effect.option);
          if (decoded._tag === "None")
            return yield* jsonError(400, "Invalid page cursor");
          cursor = decoded.value;
        }
        const page = yield* Effect.tryPromise(() => listTrash(env.DB, cursor));
        return yield* HttpServerResponse.schemaJson(ConversationPage)(
          {
            ...page,
            address: env.INBOX_EMAIL_ADDRESS ?? null,
            ...(env.INBOX_SEND && env.INBOX_EMAIL_FROM
              ? { sender: env.INBOX_EMAIL_FROM }
              : {}),
            messages: page.messages.map((mail) => ({
              ...mail,
              latestIncomingId: mail.folder === "inbox" ? mail.id : null,
              lastMessageAt: mail.deletedAt,
              archived: false,
              messageCount: 1,
              unreadCount: 0,
              participants: [{ address: mail.from, name: "" }],
              profiles: [],
            })),
          },
          { headers: privateHeaders },
        );
      }).pipe(Effect.catchTags(inboxErrors)),
    ),
    HttpRouter.add("GET", `${trashApiPath}/:id`, read("trash")),
    HttpRouter.add("GET", `${trashApiPath}/:id/original`, read("trash", true)),
    HttpRouter.add(
      "POST",
      `${inboxApiPath}/trash/:id/restore`,
      Effect.gen(function* () {
        if (!(yield* requireInboxOwner))
          return yield* jsonError(403, "Access denied");
        return yield* http.protect(recover);
      }).pipe(
        Effect.catchTags({
          ...inboxErrors,
          HookDenied: () => jsonError(403, "Request not allowed"),
        }),
      ),
    ),
  );

  const folderRoutes = (folder: MailFolder) => {
    const path = folderApiPath(folder);
    return Layer.mergeAll(
      HttpRouter.add("GET", path, list(folder)),
      HttpRouter.add("GET", `${path}/:id`, read(folder)),
      HttpRouter.add("DELETE", `${path}/:id`, remove(folder)),
    );
  };

  const send = (
    path: HttpRouter.PathInput,
    action: ReturnType<typeof sendEmail> | ReturnType<typeof sendInlineReply>,
  ) =>
    HttpRouter.add(
      "POST",
      path,
      Effect.gen(function* () {
        if (!(yield* requireInboxOwner))
          return yield* jsonError(403, "Access denied");
        return yield* http.protect(action);
      }).pipe(
        Effect.catchTags({
          ...inboxErrors,
          HookDenied: () => jsonError(403, "Request not allowed"),
          UnknownError: () =>
            jsonError(503, "Sending is temporarily unavailable."),
        }),
      ),
    );

  const listThreads = (view: Parameters<typeof listConversations>[2]) =>
    Effect.gen(function* () {
      if (!(yield* requireInboxOwner))
        return yield* jsonError(403, "Access denied");
      const query = yield* listQuery.pipe(Effect.option);
      const cursor =
        query._tag === "Some"
          ? conversationCursor(query.value.cursor, view)
          : null;
      if (!cursor) return yield* jsonError(400, "Invalid page cursor");
      const indexing = yield* Effect.tryPromise(() => syncMailIndex(env));
      const page = yield* Effect.tryPromise(async () => {
        const page = await listConversations(env.DB, cursor, view);
        const [matches, messages] = await Promise.all([
          profilesFor(
            env,
            page.messages.flatMap(({ participants }) =>
              participants.map(({ address }) => address),
            ),
          ),
          withBodyPreviews(env, page.messages),
        ]);
        const profiles = new Map(matches.map((match) => [match.email, match]));
        return {
          ...page,
          messages: messages.map((message) => ({
            ...message,
            profiles: message.participants.flatMap(({ address }) => {
              const match = profiles.get(normalizePersonEmail(address));
              return match ? [match] : [];
            }),
          })),
        };
      });
      const sender = inboxSender(env);
      return yield* HttpServerResponse.schemaJson(ConversationPage)(
        {
          ...page,
          address: env.INBOX_EMAIL_ADDRESS ?? null,
          ...(sender ? { sender: sender.from } : {}),
          ...(indexing ? { indexing } : {}),
        },
        { headers: privateHeaders },
      );
    }).pipe(Effect.catchTags(inboxErrors));

  const updateSenderRule = Effect.gen(function* () {
    if (!(yield* isJsonRequest))
      return yield* jsonError(415, "Expected a JSON request");
    const rule = yield* HttpServerRequest.schemaBodyJson(SenderRule, {
      onExcessProperty: "error",
    }).pipe(
      Effect.provideService(
        HttpServerRequest.MaxBodySize,
        ByteSize.kibibytes(1),
      ),
      Effect.option,
    );
    if (rule._tag === "None")
      return yield* jsonError(400, "Invalid sender priority");
    yield* Effect.tryPromise(() => setSenderRule(env.DB, rule.value));
    yield* Effect.sync(() => defer(notifyInbox(env)));
    return HttpServerResponse.empty({ status: 204, headers: privateHeaders });
  });

  const updateSenderAppearance = Effect.gen(function* () {
    if (!(yield* isJsonRequest))
      return yield* jsonError(415, "Expected a JSON request");
    const body = yield* HttpServerRequest.schemaBodyJson(
      SenderAppearanceUpdate,
      { onExcessProperty: "error" },
    ).pipe(
      Effect.provideService(
        HttpServerRequest.MaxBodySize,
        ByteSize.kibibytes(1),
      ),
      Effect.option,
    );
    if (body._tag === "None")
      return yield* jsonError(400, "Invalid sender appearance");
    yield* Effect.tryPromise(() => setSenderAppearance(env.DB, body.value));
    defer(notifyInbox(env));
    return HttpServerResponse.empty({ status: 204, headers: privateHeaders });
  });

  return Layer.mergeAll(
    recoveryRoutes,
    HttpRouter.add(
      "PATCH",
      senderAppearanceApiPath,
      Effect.gen(function* () {
        if (!(yield* requireInboxOwner))
          return yield* jsonError(403, "Access denied");
        return yield* http.protect(updateSenderAppearance);
      }).pipe(
        Effect.catchTags({
          ...inboxErrors,
          HookDenied: () => jsonError(403, "Request not allowed"),
          UnknownError: () =>
            jsonError(503, "Could not update sender appearance."),
        }),
      ),
    ),
    folderRoutes("inbox"),
    folderRoutes("sent"),
    HttpRouter.add(
      "GET",
      inboxUnreadPath,
      Effect.gen(function* () {
        if (!(yield* requireInboxOwner))
          return yield* jsonError(403, "Access denied");
        const unread = yield* Effect.tryPromise(() => inboxUnread(env.DB));
        return yield* HttpServerResponse.schemaJson(InboxUnread)(unread, {
          headers: privateHeaders,
        });
      }).pipe(Effect.catchTags(inboxErrors)),
    ),
    HttpRouter.add(
      "PATCH",
      `${inboxApiPath}/:id/read`,
      Effect.gen(function* () {
        if (!(yield* requireInboxOwner))
          return yield* jsonError(403, "Access denied");
        return yield* http.protect(updateReadStatus);
      }).pipe(
        Effect.catchTags({
          ...inboxErrors,
          HookDenied: () => jsonError(403, "Request not allowed"),
          UnknownError: () =>
            jsonError(503, "Could not update read status. Try again."),
        }),
      ),
    ),
    HttpRouter.add("GET", conversationsApiPath, listThreads("inbox")),
    HttpRouter.add("GET", noiseApiPath, listThreads("noise")),
    HttpRouter.add(
      "GET",
      noiseSendersApiPath,
      Effect.gen(function* () {
        if (!(yield* requireInboxOwner))
          return yield* jsonError(403, "Access denied");
        const senders = yield* Effect.tryPromise(() =>
          readNoiseSenders(env.DB),
        );
        return yield* HttpServerResponse.schemaJson(NoiseSenders)(senders, {
          headers: privateHeaders,
        });
      }).pipe(Effect.catchTags(inboxErrors)),
    ),
    HttpRouter.add("GET", archiveApiPath, listThreads("archive")),
    HttpRouter.add("GET", allMailApiPath, listThreads("all")),
    HttpRouter.add(
      "PATCH",
      senderRuleApiPath,
      Effect.gen(function* () {
        if (!(yield* requireInboxOwner))
          return yield* jsonError(403, "Access denied");
        return yield* http.protect(updateSenderRule);
      }).pipe(
        Effect.catchTags({
          ...inboxErrors,
          HookDenied: () => jsonError(403, "Request not allowed"),
          UnknownError: () =>
            jsonError(503, "Could not update sender priority."),
        }),
      ),
    ),
    HttpRouter.add(
      "PATCH",
      `${conversationsApiPath}/:id/archive`,
      Effect.gen(function* () {
        if (!(yield* requireInboxOwner))
          return yield* jsonError(403, "Access denied");
        return yield* http.protect(updateArchive);
      }).pipe(
        Effect.catchTags({
          ...inboxErrors,
          HookDenied: () => jsonError(403, "Request not allowed"),
          UnknownError: () =>
            jsonError(503, "Could not update Archive. Try again."),
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      `${conversationsApiPath}/:id`,
      Effect.gen(function* () {
        if (!(yield* requireInboxOwner))
          return yield* jsonError(403, "Access denied");
        const { id } = yield* HttpRouter.params;
        if (!isMailMessageId(id)) return yield* notFound();
        const thread = yield* Effect.tryPromise(() =>
          loadConversation(env, id),
        );
        if (!thread.messages.length) return yield* notFound();
        const addresses = thread.messages.flatMap(
          ({ people }) => people?.members.map(({ address }) => address) ?? [],
        );
        const [profiles, messages] = yield* Effect.tryPromise(() =>
          Promise.all([
            profilesFor(env, addresses),
            withBodyPreviews(env, thread.messages),
          ]),
        );
        return yield* HttpServerResponse.schemaJson(Conversation)(
          { ...thread, messages, profiles },
          { headers: privateHeaders },
        );
      }).pipe(Effect.catchTags(inboxErrors)),
    ),
    HttpRouter.add("GET", `${inboxApiPath}/:id/original`, read("inbox", true)),
    HttpRouter.add(
      "GET",
      `${inboxApiPath}/:id/attachments/:part`,
      readAttachment(false),
    ),
    HttpRouter.add(
      "GET",
      `${inboxApiPath}/:id/attachments/:part/preview`,
      readAttachment(true),
    ),
    send(inboxSendPath, sendEmail(env, defer)),
    send(`${inboxApiPath}/:id/reply`, sendInlineReply(env, defer)),
  );
};
