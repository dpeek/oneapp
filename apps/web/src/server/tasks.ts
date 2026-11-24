import type { D1Database } from "@cloudflare/workers-types";
import { ByteSize, Clock, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ItemId, TagCreate, tagsApi } from "../items-contract.ts";
import { TaskCreate, tasksApi, TaskUpdate } from "../tasks-contract.ts";
import { jsonError, privateHeaders } from "./api-response.ts";
import { AppAuth, ownerId, type authHttp } from "./auth.ts";
import { createTag } from "./items-store.ts";
import { createTask, taskIndex, updateTask } from "./tasks-store.ts";

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

export const tasksRoutes = (
  http: ReturnType<typeof authHttp>,
  db: D1Database,
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
        return jsonError(503, "Tasks are unavailable. Try again.");
      }),
    );

  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      tasksApi,
      handle(
        authenticated((account) =>
          Effect.tryPromise(() => taskIndex(db, account)).pipe(
            Effect.flatMap(json),
          ),
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
              const task = yield* Effect.tryPromise(() =>
                createTask(db, account, input.value, now),
              );
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
      `${tasksApi}/:id`,
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
              if (result.changed) return yield* json(result.task);
              if (result.task.revision !== input.value.revision)
                return yield* json(result.task, 409);
              return yield* jsonError(400, "One or more tags are unavailable.");
            }),
          ),
        ),
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
              const tag = yield* Effect.tryPromise(() =>
                createTag(db, account, input.value.name),
              );
              return yield* tag
                ? json(tag)
                : jsonError(400, "Enter a tag name.");
            }),
          ),
        ),
      ),
    ),
  );
};
