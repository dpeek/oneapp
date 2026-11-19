import type {
  R2Object,
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
  Conversation,
  conversationsApiPath,
  folderApiPath,
  inboxApiPath,
  InboxDraft,
  InboxEntry,
  InboxMessageId,
  InboxPage,
  InboxReadUpdate,
  InboxSend,
  inboxSendPath,
  InboxUnread,
  inboxUnreadPath,
  type MailFolder,
  MailMessageId,
  SentEntry,
  SentPage,
  sentCopyHeader,
} from "../inbox-contract.ts";
import { jsonError, privateHeaders } from "./api-response.ts";
import { AppAuth, ownerId, type authHttp } from "./auth.ts";
import {
  indexMail,
  inboxMessageUnread,
  inboxThreadCursor,
  inboxUnread,
  listInboxThreads,
  readThread,
  removeIndexedMail,
  scanMail,
  setInboxUnread,
} from "./mail-index.ts";
import {
  conversationMessageIds,
  parentMessageId,
  replyHeaders,
  replyRecipient,
} from "./mail-reply.ts";
import { mailPeople } from "./mail-people.ts";
import {
  describeSent,
  describeStoredSent,
  isSentMessageId,
  listSent,
  readSent,
  saveSent,
  type SentReply,
} from "./sent-mail.ts";

type InboxEnv = Pick<
  WorkerEnv,
  | "DB"
  | "INBOX_EMAIL_ADDRESS"
  | "INBOX_MESSAGES"
  | "INBOX_EMAIL_FROM"
  | "INBOX_UPDATES"
  | "SENT_MESSAGES"
> & { INBOX_SEND?: SendEmail; INBOX_SEND_LIMIT?: RateLimit };
type InboxBucket = InboxEnv["INBOX_MESSAGES"];

export const notifyInbox = async ({
  INBOX_UPDATES,
}: Pick<WorkerEnv, "INBOX_UPDATES">) => {
  if (!INBOX_UPDATES) return;
  try {
    await INBOX_UPDATES.getByName(ownerId).publish();
  } catch {
    console.warn("Could not notify Inbox subscribers");
  }
};

export const inboxSessionHeaders = {
  id: "x-oneapp-inbox-session-id",
  revision: "x-oneapp-inbox-security-revision",
};

export type InboxSocketSession = {
  sessionId: string;
  securityRevision: string;
};

const isInboxMessageId = Schema.is(InboxMessageId);
const isMailMessageId = Schema.is(MailMessageId);
const headerLimit = 64 * 1024;
const messageLimit = 8 * 1024 * 1024;
const textLimit = 256 * 1024;
const htmlLimit = 1024 * 1024;
const mimeOptions = {
  maxHeadersSize: 256 * 1024,
  maxNestingDepth: 32,
  maxPartCount: 512,
  forceRfc822Attachments: true,
};
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
  receivedAt: object.uploaded.getTime(),
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
    return { email };
  } catch {
    return { email: null };
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
    people: describePeople(email, from, to),
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

const replyInfo = (email: Email | null, envelopeFrom: string) => {
  const to = email && replyRecipient(email, envelopeFrom);
  return to && email
    ? { reply: { to, threaded: parentMessageId(email) !== undefined } }
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
    messages: await Promise.all(
      page.objects
        .filter(({ key }) => isInboxMessageId(key))
        .map(async (object) =>
          summary(object, await readSubject(bucket, object)),
        ),
    ),
    cursor: page.truncated ? page.cursor : null,
  };
};

const readMessage = async (
  env: InboxEnv,
  id: string,
): Promise<typeof InboxEntry.Type | null> => {
  const bucket = env.INBOX_MESSAGES;
  const object = await bucket.get(id);
  if (!object) return null;
  const unread =
    (await inboxMessageUnread(env.DB, id)) ??
    object.customMetadata?.initialUnread === "1";
  const to = object.customMetadata?.envelopeTo ?? env.INBOX_EMAIL_ADDRESS ?? "";
  const envelopeFrom = object.customMetadata?.envelopeFrom ?? "";
  const fallback = async (preview: "tooLarge" | "unreadable") => {
    const length = Math.min(object.size, mimeOptions.maxHeadersSize);
    const headers = length ? await readHeaders(bucket, id, length) : null;
    const subject =
      object.customMetadata?.subject ??
      headers?.email?.subject?.trim().slice(0, 200) ??
      "";
    return {
      ...summary(object, subject),
      ...replyInfo(headers?.email ?? null, envelopeFrom),
      people: describePeople(headers?.email ?? null, envelopeFrom, to),
      to,
      unread,
      text: "",
      preview,
    };
  };
  if (object.size > messageLimit) {
    await object.body.cancel();
    return fallback("tooLarge");
  }

  const bytes = await object.arrayBuffer();
  try {
    const email = await PostalMime.parse(bytes, mimeOptions);
    const html = email.text?.trim() ? "" : (email.html ?? "");
    const text = html
      ? htmlToText(html.slice(0, htmlLimit))
      : (email.text ?? "");
    const from = email.from?.address;
    return {
      ...summary(object, email.subject?.trim().slice(0, 200) ?? ""),
      ...replyInfo(email, envelopeFrom),
      people: describePeople(email, envelopeFrom, to),
      from: from
        ? email.from?.name
          ? `${email.from.name} <${from}>`
          : from
        : envelopeFrom,
      to,
      unread,
      text: text.slice(0, textLimit),
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

const sendDraft = Effect.fnUntraced(function* (
  binding: SendEmail,
  env: InboxEnv,
  message: typeof InboxDraft.Type & { from: string },
  reply: SentReply | undefined,
) {
  const sent = yield* Effect.tryPromise({
    try: () =>
      binding.send(
        reply?.headers ? { ...message, headers: reply.headers } : message,
      ),
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
    return HttpServerResponse.empty({
      status: 204,
      headers: saved
        ? privateHeaders
        : { ...privateHeaders, [sentCopyHeader]: "failed" },
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

const sendEmail = (env: InboxEnv, defer: (work: Promise<unknown>) => void) =>
  Effect.gen(function* () {
    const sender = inboxSender(env);
    if (!sender)
      return yield* jsonError(503, "Sending is unavailable for this mailbox.");
    const request = yield* HttpServerRequest.HttpServerRequest;
    const contentType = request.headers["content-type"]
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json")
      return yield* jsonError(415, "Expected a JSON request");

    const draft = yield* HttpServerRequest.schemaBodyJson(InboxSend, {
      onExcessProperty: "error",
    }).pipe(
      Effect.provideService(
        HttpServerRequest.MaxBodySize,
        ByteSize.kibibytes(256),
      ),
      Effect.option,
    );
    if (draft._tag === "None")
      return yield* jsonError(
        400,
        "Enter one valid recipient, a subject, and a plain-text message within the form limits.",
      );
    if (
      !(yield* Effect.tryPromise(() => sender.limit.limit({ key: ownerId })))
        .success
    )
      return yield* sendRateLimit();

    const { replyToId, ...message } = draft.value;
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
    const work = Effect.runPromiseExit(
      sendDraft(sender.binding, env, { ...message, from: sender.from }, reply),
    );
    // Keep the send and its archive write together if the client disconnects.
    defer(work);
    const result = yield* Effect.promise(() => work);
    return yield* result;
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
        const page = yield* Effect.tryPromise(() =>
          listSent(env.SENT_MESSAGES, query.value.cursor),
        );
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

  const read = (folder: MailFolder, original = false) =>
    Effect.gen(function* () {
      if (!(yield* requireInboxOwner))
        return yield* jsonError(403, "Access denied");
      const { id } = yield* HttpRouter.params;
      if (folder === "sent") {
        if (!isSentMessageId(id)) return yield* notFound();
        const message = yield* Effect.tryPromise(() =>
          readSent(env.SENT_MESSAGES, id),
        );
        return message
          ? yield* HttpServerResponse.schemaJson(SentEntry)(message, {
              headers: privateHeaders,
            })
          : yield* notFound();
      }
      if (!isInboxMessageId(id)) return yield* notFound();
      if (original) {
        const file = yield* Effect.tryPromise(() =>
          downloadOriginal(env.INBOX_MESSAGES, id),
        );
        return file ?? (yield* notFound());
      }
      const message = yield* Effect.tryPromise(() => readMessage(env, id));
      return message
        ? yield* HttpServerResponse.schemaJson(InboxEntry)(message, {
            headers: privateHeaders,
          })
        : yield* notFound();
    }).pipe(Effect.catchTags(inboxErrors));

  const remove = (folder: MailFolder) => {
    const bucket = folder === "sent" ? env.SENT_MESSAGES : env.INBOX_MESSAGES;
    const validId = folder === "sent" ? isSentMessageId : isInboxMessageId;
    const deleteMessage = Effect.gen(function* () {
      const { id } = yield* HttpRouter.params;
      if (!validId(id)) return yield* notFound();
      yield* Effect.tryPromise(() => bucket.delete(id));
      yield* Effect.tryPromise(() => removeIndexedMail(env.DB, folder, id));
      if (folder === "inbox") yield* Effect.sync(() => defer(notifyInbox(env)));
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

  const folderRoutes = (folder: MailFolder) => {
    const path = folderApiPath(folder);
    return Layer.mergeAll(
      HttpRouter.add("GET", path, list(folder)),
      HttpRouter.add("GET", `${path}/:id`, read(folder)),
      HttpRouter.add("DELETE", `${path}/:id`, remove(folder)),
    );
  };

  return Layer.mergeAll(
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
    HttpRouter.add(
      "GET",
      conversationsApiPath,
      Effect.gen(function* () {
        if (!(yield* requireInboxOwner))
          return yield* jsonError(403, "Access denied");
        const query = yield* listQuery.pipe(Effect.option);
        const cursor =
          query._tag === "Some" ? inboxThreadCursor(query.value.cursor) : null;
        if (!cursor) return yield* jsonError(400, "Invalid page cursor");
        const indexing = yield* Effect.tryPromise(() => syncMailIndex(env));
        const page = yield* Effect.tryPromise(() =>
          listInboxThreads(env.DB, cursor),
        );
        const sender = inboxSender(env);
        return yield* HttpServerResponse.schemaJson(InboxPage)(
          {
            ...page,
            address: env.INBOX_EMAIL_ADDRESS ?? null,
            ...(sender ? { sender: sender.from } : {}),
            ...(indexing ? { indexing } : {}),
          },
          { headers: privateHeaders },
        );
      }).pipe(Effect.catchTags(inboxErrors)),
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
        return thread.messages.length
          ? yield* HttpServerResponse.schemaJson(Conversation)(thread, {
              headers: privateHeaders,
            })
          : yield* notFound();
      }).pipe(Effect.catchTags(inboxErrors)),
    ),
    HttpRouter.add("GET", `${inboxApiPath}/:id/original`, read("inbox", true)),
    HttpRouter.add(
      "POST",
      inboxSendPath,
      Effect.gen(function* () {
        if (!(yield* requireInboxOwner))
          return yield* jsonError(403, "Access denied");
        return yield* http.protect(sendEmail(env, defer));
      }).pipe(
        Effect.catchTags({
          ...inboxErrors,
          HookDenied: () => jsonError(403, "Request not allowed"),
          UnknownError: () =>
            jsonError(503, "Sending is temporarily unavailable."),
        }),
      ),
    ),
  );
};
