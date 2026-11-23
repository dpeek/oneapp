import { ByteSize, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  MailboxId,
  MailImportPlan,
  mailImportPath,
  mailImportScope,
  mailImportMaxBytes,
  mailImportPlanMaxBytes,
} from "@oneapp/core/mail-import";
import { Sha256 } from "@oneapp/core/mail-snapshot";
import type { WorkerEnv } from "../../../../alchemy.run.ts";
import { ownerId } from "./auth.ts";
import {
  requireCliScope,
  invalidTokenResponse,
  insufficientCliScopeResponse,
} from "./cli-tokens.ts";
import {
  ensureDefaultMailbox,
  requireMailbox,
  scopeMailStore,
} from "./mailbox.ts";
import { jsonError, privateHeaders } from "./api-response.ts";
import { ingestRawMail } from "./mail-import.ts";
import { parseRawHeaders } from "./raw-mail.ts";
import {
  MailImportError,
  importHash,
  startMailImport,
  readImportEntry,
  readImportReceipt,
  finishMailImport,
} from "./mail-import-runs.ts";
import { notifyInbox } from "./inbox.ts";

const operation = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (error) =>
      error instanceof MailImportError
        ? error
        : new MailImportError({
            status: 503,
            message: "Import is temporarily unavailable; retry this operation",
          }),
  });
const errors = {
  InvalidCliToken: invalidTokenResponse,
  InsufficientCliScope: insufficientCliScopeResponse,
  MailImportError: ({ status, message }: MailImportError) =>
    jsonError(status, message),
};
const response = (body: unknown) =>
  HttpServerResponse.json(body, { headers: privateHeaders });

export const mailImportRoutes = (
  env: WorkerEnv,
  defer: (work: Promise<unknown>) => void,
) => {
  const route = (
    action: "destination" | "start" | "receipt" | "upload" | "complete",
  ) =>
    Effect.gen(function* () {
      const token = yield* requireCliScope(mailImportScope);
      if (token.ownerId !== ownerId)
        return yield* jsonError(403, "Access denied");
      const { mailbox, run, source } = yield* HttpRouter.params;
      if (!Schema.is(MailboxId)(mailbox))
        return yield* jsonError(400, "Invalid mailbox ID");
      yield* operation(() =>
        ensureDefaultMailbox(
          env.DB,
          env.INBOX_EMAIL_ADDRESS,
          env.INBOX_EMAIL_FROM,
          env.MAILBOX_ALIASES,
        ),
      );
      const destination = yield* operation(async () => {
        try {
          return await requireMailbox(env.DB, mailbox, token.ownerId);
        } catch {
          throw new MailImportError({
            status: 404,
            message: "Mailbox not found",
          });
        }
      });
      const store = scopeMailStore(env, mailbox);
      if (action === "destination")
        return yield* response({
          version: 1,
          origin: new URL(env.APP_ORIGIN).origin,
          mailboxId: mailbox,
          ownerAccountId: destination.ownerAccountId,
          name: destination.name,
          maxMessageBytes: mailImportMaxBytes,
          maxPlanBytes: mailImportPlanMaxBytes,
        });
      if (!Schema.is(MailImportPlan.fields.snapshotId)(run))
        return yield* jsonError(400, "Invalid snapshot ID");
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (action === "start") {
        if (
          request.headers["content-type"]?.split(";", 1)[0] !==
          "application/json"
        )
          return yield* jsonError(415, "Expected an import plan");
        const body = yield* request.arrayBuffer.pipe(
          Effect.provideService(
            HttpServerRequest.MaxBodySize,
            ByteSize.bytes(mailImportPlanMaxBytes),
          ),
          Effect.option,
        );
        if (body._tag === "None")
          return yield* jsonError(413, "Import plan exceeds the upload limit");
        const input = Schema.decodeUnknownOption(
          Schema.fromJsonString(MailImportPlan),
        )(new TextDecoder().decode(body.value));
        if (input._tag === "None" || input.value.snapshotId !== run)
          return yield* jsonError(400, "Invalid import plan");
        return yield* response(
          yield* operation(() => startMailImport(store.DB, input.value)),
        );
      }
      if (action === "complete") {
        const result = yield* operation(() => finishMailImport(store.DB, run));
        defer(notifyInbox(store));
        return yield* response(result);
      }
      if (!Schema.is(Sha256)(source))
        return yield* jsonError(400, "Invalid source ID");
      const entry = yield* operation(() =>
        readImportEntry(store.DB, run, source),
      );
      const receipt = yield* operation(() =>
        readImportReceipt(store.DB, entry),
      );
      if (action === "receipt") return yield* response(receipt);
      if (request.headers["content-type"] !== "message/rfc822")
        return yield* jsonError(415, "Expected original RFC 822 bytes");
      if (request.headers["content-encoding"])
        return yield* jsonError(415, "Compressed uploads are unsupported");
      const bytes = yield* request.arrayBuffer.pipe(
        Effect.provideService(
          HttpServerRequest.MaxBodySize,
          ByteSize.bytes(entry.size),
        ),
        Effect.option,
      );
      if (bytes._tag === "None" || bytes.value.byteLength !== entry.size)
        return yield* jsonError(
          413,
          "Message size does not match the import plan",
        );
      const raw = new Uint8Array(bytes.value);
      if ((yield* operation(() => importHash(raw))) !== entry.sha256)
        return yield* jsonError(
          422,
          "Message checksum does not match the import plan",
        );
      if (receipt?.completedAt !== null && receipt)
        return yield* response({ id: receipt.id, status: "skipped" });
      const parsed = yield* Effect.tryPromise(() => parseRawHeaders(raw)).pipe(
        Effect.option,
      );
      if (parsed._tag === "None")
        return yield* jsonError(422, "Message headers are missing or invalid");
      const result = yield* operation(() =>
        ingestRawMail(store, entry.metadata, raw),
      );
      yield* operation(() => readImportReceipt(store.DB, entry));
      return yield* response(result);
    }).pipe(Effect.catchTags(errors));
  const base = `${mailImportPath}/:mailbox`;
  return Layer.mergeAll(
    HttpRouter.add("GET", base, route("destination")),
    HttpRouter.add("PUT", `${base}/:run`, route("start")),
    HttpRouter.add("GET", `${base}/:run/:source`, route("receipt")),
    HttpRouter.add("PUT", `${base}/:run/:source`, route("upload")),
    HttpRouter.add("POST", `${base}/:run/complete`, route("complete")),
  );
};
