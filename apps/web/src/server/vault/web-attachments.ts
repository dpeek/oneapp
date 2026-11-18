import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import {
  AttachmentId,
  AttachmentMetadata,
  vaultAttachmentsPath,
  vaultAttachmentPath,
} from "../../vault-attachment-contract.ts";
import {
  VaultItemId,
  VaultLifecycleChange,
} from "../../vault-items-contract.ts";
import { jsonError, privateHeaders } from "../api-response.ts";
import type { authHttp } from "../auth.ts";
import {
  deleteAttachment,
  downloadAttachment,
  reserveAttachment,
  saveAttachmentBytes,
  scheduleAttachmentCleanup,
} from "./attachments.ts";
import { readPersonalVault } from "./personal.ts";
import {
  browserAuthorization,
  itemWriteErrors,
  noVault,
  readItemBody,
  requireSession,
  staleVault,
} from "./web-access.ts";

const isItem = Schema.is(VaultItemId);
const isFile = Schema.is(AttachmentId);
const UploadAttachment = Schema.Struct({
  ...VaultLifecycleChange.fields,
  name: AttachmentMetadata.fields.name,
  wrappedKey: AttachmentMetadata.fields.wrappedKey,
  size: AttachmentMetadata.fields.size,
});

const attachmentError = (status: "not_found" | "quota" | "size" | "stale") => {
  switch (status) {
    case "not_found":
      return jsonError(
        404,
        "The item or attachment is unavailable. Reload your vault.",
      );
    case "quota":
      return jsonError(
        413,
        "Your vault has reached its 64 MiB attachment quota.",
      );
    case "size":
      return jsonError(
        413,
        "The encrypted file must match its declared size and fit within 8 MiB.",
      );
    case "stale":
      return jsonError(
        409,
        "This item or attachment has changed. Reload your vault.",
      );
  }
};

export const vaultAttachmentRoutes = (
  http: ReturnType<typeof authHttp>,
  env: WorkerEnv,
  defer: (work: Promise<unknown>) => void,
) => {
  const { DB: db, VAULT_FILES: bucket } = env;
  const operate = (method: "POST" | "PUT" | "GET" | "DELETE") => {
    const handler = Effect.gen(function* () {
      const session = yield* requireSession;
      const { item, attachment } = yield* HttpRouter.params;
      if (
        !bucket ||
        !isItem(item) ||
        (method !== "POST" && !isFile(attachment))
      )
        return yield* attachmentError("not_found");
      const vault = yield* Effect.tryPromise(() =>
        readPersonalVault(db, session.subjectId),
      );
      if (!vault) return yield* noVault();
      const authorization = browserAuthorization(vault, session);
      if (method === "POST") {
        const input = yield* readItemBody(UploadAttachment);
        if (input._tag === "None")
          return yield* jsonError(400, "The encrypted attachment is invalid.");
        if (input.value.keyId !== vault.keyId) return yield* staleVault();
        const result = yield* Effect.tryPromise(() =>
          reserveAttachment(
            db,
            authorization,
            item,
            input.value.expectedRevision,
            input.value,
          ),
        );
        if (result.status !== "ready")
          return yield* attachmentError(result.status);
        const { id, name, wrappedKey, size } = result.attachment;
        return yield* HttpServerResponse.schemaJson(AttachmentMetadata)(
          { id, name, wrappedKey, size },
          {
            status: 201,
            headers: privateHeaders,
          },
        );
      }
      if (!attachment) return yield* attachmentError("not_found");
      if (method === "GET") {
        const result = yield* Effect.tryPromise(() =>
          downloadAttachment(db, bucket, authorization, item, attachment),
        );
        return result
          ? HttpServerResponse.fromWeb(result)
          : yield* attachmentError("not_found");
      }
      if (method === "PUT") {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const result = yield* Effect.tryPromise(() =>
          saveAttachmentBytes(
            db,
            bucket,
            authorization,
            item,
            attachment,
            webRequest,
          ),
        );
        if (result !== "updated") return yield* attachmentError(result);
      } else {
        const result = yield* Effect.tryPromise(() =>
          deleteAttachment(db, authorization, item, attachment),
        );
        if (result !== "updated") return yield* attachmentError(result);
        scheduleAttachmentCleanup(env, defer);
      }
      return HttpServerResponse.empty({ status: 204, headers: privateHeaders });
    });
    return HttpRouter.add(
      method,
      method === "POST"
        ? vaultAttachmentsPath(":item")
        : vaultAttachmentPath(":item", ":attachment"),
      (method === "GET" ? handler : http.protect(handler)).pipe(
        Effect.catchTags(itemWriteErrors),
      ),
    );
  };
  return Layer.mergeAll(
    operate("POST"),
    operate("PUT"),
    operate("GET"),
    operate("DELETE"),
  );
};
