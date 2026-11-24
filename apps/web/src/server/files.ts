import type { R2ObjectBody } from "@cloudflare/workers-types";
import { ByteSize, Clock, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { WorkerEnv } from "../../../../alchemy.run.ts";
import {
  FileName,
  FileTagUpdate,
  fileContentApi,
  fileApi,
  fileNameHeader,
  filesApi,
  fileUploadLimit,
} from "../files-contract.ts";
import { ItemId } from "../items-contract.ts";
import {
  attachmentDisposition,
  jsonError,
  privateHeaders,
} from "./api-response.ts";
import { AppAuth, ownerId, type authHttp } from "./auth.ts";
import { detectFilePreviewType } from "./file-preview-type.ts";
import {
  createFile,
  fileIndex,
  fileObjectKey,
  getFile,
  updateFileTags,
} from "./files-store.ts";

const json = (value: unknown, status = 200) =>
  HttpServerResponse.json(value, { status, headers: privateHeaders });
const notFound = () => jsonError(404, "File not found.");
const isId = Schema.is(ItemId);

const decodeName = (header: string | undefined) => {
  try {
    const name = decodeURIComponent(header ?? "");
    return Schema.is(FileName)(name) ? name : null;
  } catch {
    return null;
  }
};

export const filesRoutes = (
  http: ReturnType<typeof authHttp>,
  { DB: db, FILE_UPLOADS: bucket }: WorkerEnv,
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
    method: "GET" | "POST" | "PUT",
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
        if (!file) return yield* notFound();
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
      Effect.tryPromise(() => fileIndex(db, account)).pipe(
        Effect.flatMap(json),
      ),
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
        const name = decodeName(request.headers[fileNameHeader]);
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
        if (changed) return yield* json(file);
        if (file.revision !== input.value.revision)
          return yield* json(file, 409);
        return yield* jsonError(400, "One or more tags are unavailable.");
      }),
    ),
    content("preview"),
    content("download"),
  );
};
