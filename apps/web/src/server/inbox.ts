import type {
  R2Object,
  R2Objects,
  RateLimit,
  SendEmail,
} from "@cloudflare/workers-types";
import { ByteSize, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { compile } from "html-to-text";
import PostalMime, { decodeWords } from "postal-mime";
import type { WorkerEnv } from "../../../../alchemy.run.ts";
import {
  inboxApiPath,
  InboxDraft,
  InboxEntry,
  InboxMessageId,
  InboxPage,
  inboxSendPath,
} from "../inbox-contract.ts";
import { jsonError, privateHeaders } from "./api-response.ts";
import { AppAuth, ownerId, type authHttp } from "./auth.ts";

type InboxEnv = Pick<
  WorkerEnv,
  "INBOX_EMAIL_ADDRESS" | "INBOX_MESSAGES" | "INBOX_EMAIL_FROM"
> & { INBOX_SEND?: SendEmail; INBOX_SEND_LIMIT?: RateLimit };
type InboxBucket = InboxEnv["INBOX_MESSAGES"];

export const inboxSessionHeaders = {
  id: "x-oneapp-inbox-session-id",
  revision: "x-oneapp-inbox-security-revision",
};

export type InboxSocketSession = {
  sessionId: string;
  securityRevision: string;
};

const isMessageId = Schema.is(InboxMessageId);
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
    { selector: "img", format: "skip" },
    { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
    { selector: "script", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "svg", format: "skip" },
  ],
});

// R2 lists keys in ascending order, so new messages sort newest first.
export const inboxMessageKey = () => {
  const time = String(9_999_999_999_999 - Date.now()).padStart(13, "0");
  return `0-${time}-${crypto.randomUUID()}.eml`;
};

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

const readSubject = async (bucket: InboxBucket, object: R2Object) => {
  if (object.customMetadata?.subject !== undefined)
    return object.customMetadata.subject;
  // Messages saved before subjects were indexed only need a header-sized read.
  if (!object.size) return "";
  const headers = await bucket.get(object.key, {
    range: { offset: 0, length: Math.min(object.size, headerLimit) },
  });
  if (!headers) return "";
  const raw = await headers.text();
  const boundary = raw.search(/\r\n\r\n|\n\n|\r\r/u);
  try {
    const parsed = await PostalMime.parse(
      (boundary < 0 ? raw : raw.slice(0, boundary)) + "\r\n\r\n",
      mimeOptions,
    );
    return parsed.subject?.trim().slice(0, 200) ?? "";
  } catch {
    return "";
  }
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
        .filter(({ key }) => isMessageId(key))
        .map(async (object) =>
          summary(object, await readSubject(bucket, object)),
        ),
    ),
    cursor: page.truncated ? page.cursor : null,
    address: env.INBOX_EMAIL_ADDRESS ?? null,
    sender: inboxSender(env)?.from,
  };
};

const readMessage = async (
  env: InboxEnv,
  id: string,
): Promise<typeof InboxEntry.Type | null> => {
  const bucket = env.INBOX_MESSAGES;
  const object = await bucket.get(id);
  if (!object) return null;
  const to = object.customMetadata?.envelopeTo ?? env.INBOX_EMAIL_ADDRESS ?? "";
  const fallback = async (preview: "tooLarge" | "unreadable") => ({
    ...summary(object, await readSubject(bucket, object)),
    to,
    text: "",
    preview,
  });
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
      from: from
        ? email.from?.name
          ? `${email.from.name} <${from}>`
          : from
        : (object.customMetadata?.envelopeFrom ?? ""),
      to,
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

const sendEmail = (env: InboxEnv) =>
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

    const draft = yield* HttpServerRequest.schemaBodyJson(InboxDraft, {
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

    const sent = yield* Effect.tryPromise({
      try: () => sender.binding.send({ ...draft.value, from: sender.from }),
      catch: (error) =>
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined,
    }).pipe(Effect.withTracerEnabled(false), Effect.result);
    if (sent._tag === "Success") {
      return sent.success?.messageId
        ? HttpServerResponse.empty({ status: 204, headers: privateHeaders })
        : yield* unknownSend();
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
  });

export const inboxRoutes = (
  http: ReturnType<typeof authHttp>,
  env: InboxEnv,
) => {
  const remove = Effect.gen(function* () {
    const { id } = yield* HttpRouter.params;
    if (!isMessageId(id)) return yield* notFound();
    yield* Effect.tryPromise(() => env.INBOX_MESSAGES.delete(id));
    return HttpServerResponse.empty({ status: 204, headers: privateHeaders });
  });

  const read = (original: boolean) =>
    Effect.gen(function* () {
      if (!(yield* requireInboxOwner))
        return yield* jsonError(403, "Access denied");
      const { id } = yield* HttpRouter.params;
      if (!isMessageId(id)) return yield* notFound();
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

  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      inboxApiPath,
      Effect.gen(function* () {
        if (!(yield* requireInboxOwner))
          return yield* jsonError(403, "Access denied");
        const query = yield* listQuery.pipe(Effect.option);
        if (query._tag === "None")
          return yield* jsonError(400, "Invalid page cursor");
        const page = yield* Effect.tryPromise(() =>
          listMessages(env, query.value.cursor),
        );
        return yield* HttpServerResponse.schemaJson(InboxPage)(page, {
          headers: privateHeaders,
        });
      }).pipe(Effect.catchTags(inboxErrors)),
    ),
    HttpRouter.add("GET", `${inboxApiPath}/:id`, read(false)),
    HttpRouter.add("GET", `${inboxApiPath}/:id/original`, read(true)),
    HttpRouter.add(
      "POST",
      inboxSendPath,
      Effect.gen(function* () {
        if (!(yield* requireInboxOwner))
          return yield* jsonError(403, "Access denied");
        return yield* http.protect(sendEmail(env));
      }).pipe(
        Effect.catchTags({
          ...inboxErrors,
          HookDenied: () => jsonError(403, "Request not allowed"),
          UnknownError: () =>
            jsonError(503, "Sending is temporarily unavailable."),
        }),
      ),
    ),
    HttpRouter.add(
      "DELETE",
      `${inboxApiPath}/:id`,
      Effect.gen(function* () {
        if (!(yield* requireInboxOwner))
          return yield* jsonError(403, "Access denied");
        return yield* http.protect(remove);
      }).pipe(
        Effect.catchTags({
          ...inboxErrors,
          HookDenied: () => jsonError(403, "Request not allowed"),
          UnknownError: () =>
            jsonError(503, "Could not delete this email. Try again."),
        }),
      ),
    ),
  );
};
