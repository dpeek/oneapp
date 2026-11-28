import type { R2ObjectBody } from "@cloudflare/workers-types";
import { ByteSize, Clock, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { WorkerEnv } from "../../../../alchemy.run.ts";
import {
  FileDeletion,
  FileDocumentUpdate,
  FileTagUpdate,
  fileDocumentApi,
  fileDocumentsApi,
  fileImageApi,
  fileContentApi,
  fileApi,
  fileNameHeader,
  filesApi,
  filesChanged,
  fileUploadLimit,
} from "../files-contract.ts";
import {
  ImageMediaType,
  imageUploadLimit,
  invalidImage,
} from "../image-upload.ts";
import { ItemId } from "../items-contract.ts";
import type { NotifyItemChange } from "../workspace-change-contract.ts";
import {
  attachmentDisposition,
  jsonError,
  privateHeaders,
  readFileName,
} from "./api-response.ts";
import { AppAuth, ownerId, type authHttp } from "./auth.ts";
import { detectFilePreviewType } from "../file-preview-type.ts";
import {
  createDocument,
  createDocumentImage,
  createFile,
  deleteFile,
  fileIndex,
  fileObjectKey,
  fileVersion,
  getFile,
  readDocument,
  readDocumentImage,
  updateDocument,
  updateFileTags,
} from "./files-store.ts";

const json = (value: unknown, status = 200) =>
  HttpServerResponse.json(value, { status, headers: privateHeaders });
const notFound = () => jsonError(404, "File not found.");
const isId = Schema.is(ItemId);

export const filesRoutes = (
  http: ReturnType<typeof authHttp>,
  { DB: db, FILE_UPLOADS: bucket }: WorkerEnv,
  notifyItemChange: NotifyItemChange,
) => {
  const authenticated = <E, R>(
    handler: (
      account: string,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) =>
    Effect.gen(function* () {
      const auth = yield* AppAuth;
      const { subjectId } = yield* auth.requireSession;
      if (subjectId !== ownerId)
        return yield* jsonError(403, "Request not allowed");
      return yield* handler(subjectId);
    });

  const route = <E, R>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: HttpRouter.PathInput,
    handler: (
      account: string,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) => {
    const access = authenticated(handler);
    return HttpRouter.add(
      method,
      path,
      (method === "GET" ? access : http.protect(access)).pipe(
        Effect.catch((error) => {
          const tag =
            typeof error === "object" && error !== null && "_tag" in error
              ? error._tag
              : null;
          if (tag === "AuthenticationRequired")
            return jsonError(401, "Sign in required");
          if (tag === "HookDenied")
            return jsonError(403, "Request not allowed");
          return jsonError(503, "Files are unavailable. Try again.");
        }),
      ),
    );
  };

  const content = (action: "preview" | "download") =>
    route("GET", fileContentApi(":id", action), (account) =>
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.params;
        if (!isId(id)) return yield* notFound();
        const file = yield* Effect.tryPromise(() => getFile(db, account, id));
        if (!file || file.authored) return yield* notFound();
        const preview = action === "preview" ? file.previewType : null;
        if (action === "preview" && !preview)
          return yield* jsonError(415, "Preview is unavailable for this file.");
        const object = yield* Effect.tryPromise<R2ObjectBody | null>(() =>
          bucket.get(fileObjectKey(account, id)),
        );
        if (!object) return yield* notFound();
        return HttpServerResponse.fromWeb(
          new Response(object.body as unknown as ReadableStream<Uint8Array>, {
            headers: {
              ...privateHeaders,
              "content-type": preview ?? "application/octet-stream",
              "content-disposition": preview?.startsWith("image/")
                ? "inline"
                : attachmentDisposition(file.name),
              "content-length": String(object.size),
              "x-content-type-options": "nosniff",
              "content-security-policy": "default-src 'none'; sandbox",
              "cross-origin-resource-policy": "same-origin",
            },
          }),
        );
      }),
    );

  return Layer.mergeAll(
    route("GET", filesApi, (account) =>
      Effect.gen(function* () {
        const { since } = yield* HttpServerRequest.ParsedSearchParams;
        if (typeof since === "string") {
          const version = yield* Effect.tryPromise(() =>
            fileVersion(db, account),
          );
          if (since === String(version))
            return HttpServerResponse.empty({
              status: 204,
              headers: privateHeaders,
            });
        }
        const index = yield* Effect.tryPromise(() => fileIndex(db, account));
        return yield* json(index);
      }),
    ),
    route("GET", fileApi(":id"), (account) =>
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.params;
        if (!isId(id)) return yield* notFound();
        const file = yield* Effect.tryPromise(() => getFile(db, account, id));
        return yield* file ? json(file) : notFound();
      }),
    ),
    route("POST", filesApi, (account) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const name = readFileName(request.headers[fileNameHeader]);
        if (!name) return yield* jsonError(400, "The filename is invalid.");
        const uploadTooLarge = () =>
          jsonError(413, "Choose a file up to 16 MiB.");
        if (Number(request.headers["content-length"]) > fileUploadLimit)
          return yield* uploadTooLarge();
        const body = yield* request.arrayBuffer.pipe(
          Effect.provideService(
            HttpServerRequest.MaxBodySize,
            ByteSize.bytes(fileUploadLimit),
          ),
          Effect.option,
        );
        if (body._tag === "None") return yield* uploadTooLarge();
        const previewType = detectFilePreviewType(new Uint8Array(body.value));
        const declared = request.headers["content-type"]?.toLowerCase() ?? "";
        const mediaType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(
          declared,
        )
          ? declared
          : (previewType ?? "application/octet-stream");
        const now = yield* Clock.currentTimeMillis;
        const file = yield* Effect.tryPromise(() =>
          createFile(
            db,
            bucket,
            account,
            { name, mediaType, previewType },
            body.value,
            now,
          ),
        );
        notifyItemChange(account, filesChanged);
        return yield* json(file, 201);
      }),
    ),
    route("PUT", fileApi(":id"), (account) =>
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.params;
        if (!isId(id)) return yield* notFound();
        const input = yield* HttpServerRequest.schemaBodyJson(
          FileTagUpdate,
        ).pipe(
          Effect.provideService(
            HttpServerRequest.MaxBodySize,
            ByteSize.kibibytes(4),
          ),
          Effect.option,
        );
        if (input._tag === "None")
          return yield* jsonError(400, "Check the file tags.");
        const now = yield* Clock.currentTimeMillis;
        const { file, changed } = yield* Effect.tryPromise(() =>
          updateFileTags(db, account, id, input.value, now),
        );
        if (!file) return yield* notFound();
        if (changed) {
          notifyItemChange(account, filesChanged);
          return yield* json(file);
        }
        if (file.revision !== input.value.revision)
          return yield* json(file, 409);
        return yield* jsonError(400, "One or more tags are unavailable.");
      }),
    ),
    route("POST", fileDocumentsApi, (account) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const document = yield* Effect.tryPromise(() =>
          createDocument(db, bucket, account, now),
        );
        notifyItemChange(account, filesChanged);
        return yield* json(document, 201);
      }),
    ),
    route("GET", fileDocumentApi(":id"), (account) =>
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.params;
        if (!isId(id)) return yield* notFound();
        const document = yield* Effect.tryPromise(() =>
          readDocument(db, bucket, account, id),
        );
        return yield* document ? json(document) : notFound();
      }),
    ),
    route("PUT", fileDocumentApi(":id"), (account) =>
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.params;
        if (!isId(id)) return yield* notFound();
        const input = yield* HttpServerRequest.schemaBodyJson(
          FileDocumentUpdate,
        ).pipe(
          Effect.provideService(
            HttpServerRequest.MaxBodySize,
            ByteSize.kibibytes(128),
          ),
          Effect.option,
        );
        if (input._tag === "None")
          return yield* jsonError(
            400,
            "Check the document title and Markdown.",
          );
        const now = yield* Clock.currentTimeMillis;
        const result = yield* Effect.tryPromise(() =>
          updateDocument(db, bucket, account, id, input.value, now),
        );
        if (result === "missing") return yield* notFound();
        if (result === "image_unavailable")
          return yield* jsonError(
            422,
            "An image is unavailable. Remove it and insert it again.",
          );
        if (result === "conflict") {
          const document = yield* Effect.tryPromise(() =>
            readDocument(db, bucket, account, id),
          );
          return yield* document ? json(document, 409) : notFound();
        }
        notifyItemChange(account, filesChanged);
        return yield* json(result);
      }),
    ),
    route("POST", fileImageApi(":id", ":imageId"), (account) =>
      Effect.gen(function* () {
        const { id, imageId } = yield* HttpRouter.params;
        if (!isId(id) || !isId(imageId)) return yield* notFound();
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (Number(request.headers["content-length"]) > imageUploadLimit)
          return yield* jsonError(413, invalidImage);
        const body = yield* request.arrayBuffer.pipe(
          Effect.provideService(
            HttpServerRequest.MaxBodySize,
            ByteSize.bytes(imageUploadLimit),
          ),
          Effect.option,
        );
        if (body._tag === "None" || body.value.byteLength > imageUploadLimit)
          return yield* jsonError(413, invalidImage);
        const mediaType = detectFilePreviewType(new Uint8Array(body.value));
        if (!Schema.is(ImageMediaType)(mediaType))
          return yield* jsonError(415, invalidImage);
        const now = yield* Clock.currentTimeMillis;
        const saved = yield* Effect.tryPromise(() =>
          createDocumentImage(
            db,
            bucket,
            account,
            id,
            imageId,
            mediaType,
            body.value,
            now,
          ),
        );
        return yield* saved ? json({ id: imageId }, 201) : notFound();
      }),
    ),
    route("GET", fileImageApi(":id", ":imageId"), (account) =>
      Effect.gen(function* () {
        const { id, imageId } = yield* HttpRouter.params;
        if (!isId(id) || !isId(imageId)) return yield* notFound();
        const object = yield* Effect.tryPromise(() =>
          readDocumentImage(db, bucket, account, id, imageId),
        );
        if (!object) return yield* notFound();
        const mediaType = object.httpMetadata?.contentType;
        return HttpServerResponse.fromWeb(
          new Response(object.body as unknown as ReadableStream<Uint8Array>, {
            headers: {
              ...privateHeaders,
              "content-type": Schema.is(ImageMediaType)(mediaType)
                ? mediaType
                : "application/octet-stream",
              "content-disposition": "inline",
              "content-length": String(object.size),
              "x-content-type-options": "nosniff",
              "content-security-policy": "default-src 'none'; sandbox",
              "cross-origin-resource-policy": "same-origin",
            },
          }),
        );
      }),
    ),
    route("DELETE", fileApi(":id"), (account) =>
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.params;
        if (!isId(id)) return yield* notFound();
        const input = yield* HttpServerRequest.schemaBodyJson(
          FileDeletion,
        ).pipe(
          Effect.provideService(
            HttpServerRequest.MaxBodySize,
            ByteSize.kibibytes(1),
          ),
          Effect.option,
        );
        if (input._tag === "None")
          return yield* jsonError(400, "Check the file revision.");
        const now = yield* Clock.currentTimeMillis;
        const result = yield* Effect.tryPromise(() =>
          deleteFile(db, bucket, account, id, input.value.revision, now),
        );
        if (!result) return yield* notFound();
        if (result !== "deleted") return yield* json(result, 409);
        notifyItemChange(account, filesChanged);
        return HttpServerResponse.empty({
          status: 204,
          headers: privateHeaders,
        });
      }),
    ),
    content("preview"),
    content("download"),
  );
};
