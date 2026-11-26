import type { WorkerEnv } from "../../../../alchemy.run.ts";
import { ByteSize, Clock, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  ItemId,
  Tag,
  tagApi,
  TagCreate,
  tagsApi,
  tagsChanged,
} from "../items-contract.ts";
import { fileNameHeader } from "../files-contract.ts";
import {
  TaskAttachmentMediaType,
  taskAttachmentApi,
  taskAttachmentIdHeader,
  taskAttachmentLimit,
  taskAttachmentLimitMiB,
  taskAttachmentsApi,
} from "../task-attachment-contract.ts";
import {
  taskApi,
  TaskAssignee,
  TaskCreate,
  TaskDelete,
  tasksApi,
  tasksChanged,
  TaskUpdate,
} from "../tasks-contract.ts";
import type { NotifyItemChange } from "../workspace-change-contract.ts";
import { jsonError, privateHeaders, readFileName } from "./api-response.ts";
import { AppAuth, ownerId, type authHttp } from "./auth.ts";
import { createTag, removeTag, renameTag, tagCatalog } from "./items-store.ts";
import {
  createTask,
  deleteTask,
  getTask,
  taskIndex,
  taskVersion,
  updateTask,
} from "./tasks-store.ts";
import { detectFilePreviewType } from "../file-preview-type.ts";
import {
  createTaskAttachment,
  listTaskAttachments,
  purgeTaskAttachment,
  readTaskAttachment,
  removeTaskAttachment,
} from "./task-attachments-store.ts";

const json = (value: unknown, status = 200) =>
  HttpServerResponse.json(value, { status, headers: privateHeaders });
const readInput = <A>(schema: Schema.Decoder<A>) =>
  HttpServerRequest.schemaBodyJson(schema).pipe(
    Effect.provideService(
      HttpServerRequest.MaxBodySize,
      ByteSize.kibibytes(128),
    ),
    Effect.option,
  );
const isId = Schema.is(ItemId);

export const tasksRoutes = (
  http: ReturnType<typeof authHttp>,
  { DB: db, FILE_UPLOADS: bucket }: Pick<WorkerEnv, "DB" | "FILE_UPLOADS">,
  defer: (work: Promise<unknown>) => void,
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
  const handle = <E, R>(
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    unavailable = "Tasks are unavailable. Try again.",
  ) =>
    handler.pipe(
      Effect.catch((error) => {
        const tag =
          typeof error === "object" && error !== null && "_tag" in error
            ? error._tag
            : null;
        if (tag === "AuthenticationRequired")
          return jsonError(401, "Sign in required");
        if (tag === "HookDenied") return jsonError(403, "Request not allowed");
        return jsonError(503, unavailable);
      }),
    );
  const attachmentsPath = taskAttachmentsApi(":taskId");
  const tagPath = tagApi(":id");
  const tagsUnavailable = "Tags are unavailable. Try again.";
  const attachmentPath = taskAttachmentApi(":taskId", ":attachmentId");
  const attachmentRoute = <E, R>(
    method: "GET" | "POST" | "DELETE",
    path: typeof attachmentsPath | typeof attachmentPath,
    handler: (
      account: string,
      taskId: string,
      attachmentId: string,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) => {
    const access = authenticated((account) =>
      Effect.gen(function* () {
        const { taskId, attachmentId } = yield* HttpRouter.params;
        if (!isId(taskId)) return yield* jsonError(404, "Task not found.");
        if (path === attachmentPath && !isId(attachmentId))
          return yield* jsonError(404, "Screenshot not found.");
        return yield* handler(account, taskId, attachmentId ?? "");
      }),
    );
    return HttpRouter.add(
      method,
      path,
      handle(method === "GET" ? access : http.protect(access)),
    );
  };

  return Layer.mergeAll(
    attachmentRoute("GET", attachmentsPath, (account, taskId) =>
      Effect.gen(function* () {
        const task = yield* Effect.tryPromise(() =>
          getTask(db, account, taskId),
        );
        if (!task) return yield* jsonError(404, "Task not found.");
        const attachments = yield* Effect.tryPromise(() =>
          listTaskAttachments(db, account, taskId),
        );
        return yield* json({ attachments });
      }),
    ),
    attachmentRoute("POST", attachmentsPath, (account, taskId) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const id = request.headers[taskAttachmentIdHeader];
        if (id !== undefined && !isId(id))
          return yield* jsonError(400, "Invalid screenshot ID.");
        const name = readFileName(request.headers[fileNameHeader]);
        if (!name)
          return yield* jsonError(400, "Rename the screenshot and try again.");
        const tooLarge = () =>
          jsonError(
            413,
            `Choose a PNG or JPEG up to ${taskAttachmentLimitMiB} MiB.`,
          );
        if (Number(request.headers["content-length"]) > taskAttachmentLimit)
          return yield* tooLarge();
        const body = yield* request.arrayBuffer.pipe(
          Effect.provideService(
            HttpServerRequest.MaxBodySize,
            ByteSize.bytes(taskAttachmentLimit),
          ),
          Effect.option,
        );
        if (body._tag === "None" || body.value.byteLength > taskAttachmentLimit)
          return yield* tooLarge();
        const mediaType = detectFilePreviewType(new Uint8Array(body.value));
        if (!Schema.is(TaskAttachmentMediaType)(mediaType))
          return yield* jsonError(415, "Choose or paste a PNG or JPEG image.");
        const now = yield* Clock.currentTimeMillis;
        const attachment = yield* Effect.tryPromise(() =>
          createTaskAttachment(
            db,
            bucket,
            account,
            taskId,
            { name, mediaType },
            body.value,
            now,
            id,
          ),
        );
        return yield* attachment
          ? json(attachment, 201)
          : jsonError(404, "Task not found.");
      }),
    ),
    attachmentRoute("GET", attachmentPath, (account, taskId, id) =>
      Effect.gen(function* () {
        const stored = yield* Effect.tryPromise(() =>
          readTaskAttachment(db, bucket, account, taskId, id),
        );
        if (!stored) return yield* jsonError(404, "Screenshot not found.");
        const { attachment, object } = stored;
        return HttpServerResponse.fromWeb(
          new Response(object.body as unknown as ReadableStream<Uint8Array>, {
            headers: {
              ...privateHeaders,
              "content-type": attachment.mediaType,
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
    attachmentRoute("DELETE", attachmentPath, (account, taskId, id) =>
      Effect.gen(function* () {
        const removed = yield* Effect.tryPromise(() =>
          removeTaskAttachment(db, account, taskId, id),
        );
        if (!removed) return yield* jsonError(404, "Screenshot not found.");
        defer(
          purgeTaskAttachment(db, bucket, account, taskId, id).catch(() =>
            console.warn("Could not finish screenshot cleanup"),
          ),
        );
        return HttpServerResponse.empty({
          status: 204,
          headers: privateHeaders,
        });
      }),
    ),
    HttpRouter.add(
      "GET",
      tasksApi,
      handle(
        authenticated((account) =>
          Effect.gen(function* () {
            const { since, assignee: assigneeParam } =
              yield* HttpServerRequest.ParsedSearchParams;
            const assignee =
              assigneeParam === "unassigned" ? null : assigneeParam;
            if (assignee !== undefined && !Schema.is(TaskAssignee)(assignee))
              return yield* jsonError(400, "Choose a valid assignee.");
            if (typeof since === "string") {
              const version = yield* Effect.tryPromise(() =>
                taskVersion(db, account),
              );
              if (since === String(version))
                return HttpServerResponse.empty({
                  status: 204,
                  headers: privateHeaders,
                });
            }
            const index = yield* Effect.tryPromise(() =>
              taskIndex(db, account, assignee),
            );
            return yield* json(index);
          }),
        ),
      ),
    ),
    HttpRouter.add(
      "POST",
      tasksApi,
      handle(
        http.protect(
          authenticated((account) =>
            Effect.gen(function* () {
              const input = yield* readInput(TaskCreate);
              if (input._tag === "None")
                return yield* jsonError(
                  400,
                  "Check the task title, due date and other fields.",
                );
              const now = yield* Clock.currentTimeMillis;
              const { task, changed } = yield* Effect.tryPromise(() =>
                createTask(
                  db,
                  { accountId: account, kind: "owner" },
                  input.value,
                  now,
                ),
              );
              if (changed) notifyItemChange(account, tasksChanged);
              return yield* task
                ? json(task, 201)
                : jsonError(409, "Could not create the task.");
            }),
          ),
        ),
      ),
    ),
    HttpRouter.add(
      "PUT",
      taskApi(":id"),
      handle(
        http.protect(
          authenticated((account) =>
            Effect.gen(function* () {
              const { id } = yield* HttpRouter.params;
              if (!Schema.is(ItemId)(id))
                return yield* jsonError(404, "Task not found.");
              const input = yield* readInput(TaskUpdate);
              if (input._tag === "None")
                return yield* jsonError(
                  400,
                  "Check the task title, due date and other fields.",
                );
              const now = yield* Clock.currentTimeMillis;
              const result = yield* Effect.tryPromise(() =>
                updateTask(db, account, id, input.value, now),
              );
              if (!result.task) return yield* jsonError(404, "Task not found.");
              if (result.changed) {
                notifyItemChange(account, tasksChanged);
                return yield* json(result.task);
              }
              if (result.task.revision !== input.value.revision)
                return yield* json(result.task, 409);
              return yield* jsonError(400, "One or more tags are unavailable.");
            }),
          ),
        ),
      ),
    ),
    HttpRouter.add(
      "DELETE",
      taskApi(":id"),
      handle(
        http.protect(
          authenticated((account) =>
            Effect.gen(function* () {
              const { id } = yield* HttpRouter.params;
              if (!isId(id)) return yield* jsonError(404, "Task not found.");
              const input = yield* readInput(TaskDelete);
              if (input._tag === "None")
                return yield* jsonError(400, "A task revision is required.");
              const result = yield* Effect.tryPromise(() =>
                deleteTask(db, account, id, input.value.revision),
              );
              if (result === "missing")
                return yield* jsonError(404, "Task not found.");
              if (result === "conflict")
                return yield* jsonError(409, "The task changed. Try again.");
              notifyItemChange(account, tasksChanged);
              return HttpServerResponse.empty({
                status: 204,
                headers: privateHeaders,
              });
            }),
          ),
        ),
      ),
    ),
    HttpRouter.add(
      "GET",
      tagsApi,
      handle(
        authenticated((account) =>
          Effect.tryPromise(() => tagCatalog(db, account).all<Tag>()).pipe(
            Effect.flatMap(({ results }) => json(results)),
          ),
        ),
        tagsUnavailable,
      ),
    ),
    HttpRouter.add(
      "POST",
      tagsApi,
      handle(
        http.protect(
          authenticated((account) =>
            Effect.gen(function* () {
              const input = yield* readInput(TagCreate);
              if (input._tag === "None")
                return yield* jsonError(400, "Enter a tag name.");
              const created = yield* Effect.tryPromise(() =>
                createTag(db, account, input.value.name),
              );
              if (!created) return yield* jsonError(400, "Enter a tag name.");
              if (created.changed) notifyItemChange(account, tagsChanged);
              return yield* json(created.tag);
            }),
          ),
        ),
        tagsUnavailable,
      ),
    ),
    HttpRouter.add(
      "PUT",
      tagPath,
      handle(
        http.protect(
          authenticated((account) =>
            Effect.gen(function* () {
              const { id } = yield* HttpRouter.params;
              if (!isId(id)) return yield* jsonError(404, "Tag not found.");
              const input = yield* readInput(TagCreate);
              if (input._tag === "None")
                return yield* jsonError(400, "Enter a tag name.");
              const tag = yield* Effect.tryPromise(() =>
                renameTag(db, account, id, input.value.name),
              );
              if (tag === "invalid")
                return yield* jsonError(400, "Enter a tag name.");
              if (tag === "conflict")
                return yield* jsonError(
                  409,
                  "A tag with this name already exists.",
                );
              if (!tag) return yield* jsonError(404, "Tag not found.");
              notifyItemChange(account, tagsChanged);
              return yield* json(tag);
            }),
          ),
        ),
        tagsUnavailable,
      ),
    ),
    HttpRouter.add(
      "DELETE",
      tagPath,
      handle(
        http.protect(
          authenticated((account) =>
            Effect.gen(function* () {
              const { id } = yield* HttpRouter.params;
              if (!isId(id)) return yield* jsonError(404, "Tag not found.");
              const removed = yield* Effect.tryPromise(() =>
                removeTag(db, account, id),
              );
              if (!removed) return yield* jsonError(404, "Tag not found.");
              notifyItemChange(account, tagsChanged);
              return HttpServerResponse.empty({
                status: 204,
                headers: privateHeaders,
              });
            }),
          ),
        ),
        tagsUnavailable,
      ),
    ),
  );
};
