import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import {
  CreateVaultFolder,
  EditVaultFolder,
  VaultBulkChange,
  vaultBulkPath,
  VaultFolder,
  vaultFoldersPath,
  VaultItem,
  VaultItemId,
  VaultLifecycleChange,
} from "../../vault-items-contract.ts";
import { ImportPayload, parseImport } from "../bitwarden/import-request.ts";
import {
  vaultImportBytes,
  vaultImportPath,
} from "../../vault-transfer-contract.ts";
import { scheduleAttachmentCleanup } from "./attachments.ts";
import { importPersonalVault } from "./import.ts";
import { jsonError, privateHeaders } from "../api-response.ts";
import type { authHttp } from "../auth.ts";
import { changeFolder, createFolder, projectFolder } from "./folders.ts";
import { projectItem } from "./items.ts";
import { changeItemSelection } from "./lifecycle.ts";
import { readPersonalVault } from "./personal.ts";
import {
  browserAuthorization,
  itemWriteErrors,
  noVault,
  readItemBody,
  requireSession,
  staleVault,
} from "./web-access.ts";

const isItemId = Schema.is(VaultItemId);

export const vaultManagementRoutes = (
  http: ReturnType<typeof authHttp>,
  env: WorkerEnv,
  defer: (work: Promise<unknown>) => void,
) => {
  const db = env.DB;
  const secure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    http.protect(effect);
  const folderResponse = (
    folder: Parameters<typeof projectFolder>[0],
    status = 200,
  ) =>
    HttpServerResponse.schemaJson(VaultFolder)(projectFolder(folder), {
      status,
      headers: privateHeaders,
    });
  const folderChange = (method: "PUT" | "DELETE") =>
    HttpRouter.add(
      method,
      `${vaultFoldersPath}/:id`,
      secure(
        Effect.gen(function* () {
          const session = yield* requireSession;
          const { id } = yield* HttpRouter.params;
          if (!isItemId(id)) return yield* jsonError(404, "Folder not found.");
          const input = yield* readItemBody(
            method === "PUT" ? EditVaultFolder : VaultLifecycleChange,
          );
          if (input._tag === "None")
            return yield* jsonError(400, "Invalid folder change.");
          const vault = yield* Effect.tryPromise(() =>
            readPersonalVault(db, session.subjectId),
          );
          if (!vault) return yield* noVault();
          if (input.value.keyId !== vault.keyId) return yield* staleVault();
          const change = yield* Effect.tryPromise(() =>
            changeFolder(
              db,
              browserAuthorization(vault, session),
              id,
              "name" in input.value && typeof input.value.name === "string"
                ? {
                    kind: "rename",
                    name: input.value.name,
                    expectedRevision: input.value.expectedRevision,
                  }
                : { kind: "delete", ...input.value },
            ),
          );
          switch (change.status) {
            case "updated":
              return method === "DELETE"
                ? HttpServerResponse.empty({
                    status: 204,
                    headers: privateHeaders,
                  })
                : yield* folderResponse(change.folder);
            case "unauthorized":
              return yield* itemWriteErrors.AuthenticationRequired();
            case "not_found":
              return yield* jsonError(404, "Folder not found.");
            case "conflict":
              return yield* jsonError(
                409,
                "This folder changed. Reload your vault.",
              );
          }
        }),
      ).pipe(Effect.catchTags(itemWriteErrors)),
    );

  return Layer.mergeAll(
    HttpRouter.add(
      "POST",
      vaultFoldersPath,
      secure(
        Effect.gen(function* () {
          const session = yield* requireSession;
          const input = yield* readItemBody(CreateVaultFolder);
          if (input._tag === "None")
            return yield* jsonError(400, "Invalid encrypted folder.");
          const vault = yield* Effect.tryPromise(() =>
            readPersonalVault(db, session.subjectId),
          );
          if (!vault) return yield* noVault();
          if (vault.keyId !== input.value.keyId) return yield* staleVault();
          const folder = yield* Effect.tryPromise(() =>
            createFolder(
              db,
              browserAuthorization(vault, session),
              input.value.name,
            ),
          );
          if (!folder) return yield* itemWriteErrors.AuthenticationRequired();
          return yield* folderResponse(folder, 201);
        }),
      ).pipe(Effect.catchTags(itemWriteErrors)),
    ),
    HttpRouter.add(
      "POST",
      vaultImportPath,
      secure(
        Effect.gen(function* () {
          const session = yield* requireSession;
          const input = yield* readItemBody(
            Schema.Struct({
              keyId: CreateVaultFolder.fields.keyId,
              ...ImportPayload.fields,
            }),
            vaultImportBytes,
          );
          if (input._tag === "None")
            return yield* jsonError(
              400,
              "Invalid encrypted import or import exceeds its limits.",
            );
          const vault = yield* Effect.tryPromise(() =>
            readPersonalVault(db, session.subjectId),
          );
          if (!vault) return yield* noVault();
          if (vault.keyId !== input.value.keyId) return yield* staleVault();
          const parsed = parseImport(input.value, vault);
          if ("error" in parsed) return yield* jsonError(400, parsed.error);
          const imported = yield* Effect.tryPromise(() =>
            importPersonalVault(
              db,
              browserAuthorization(vault, session),
              parsed.data,
            ),
          );
          return imported
            ? yield* HttpServerResponse.json(imported, {
                headers: privateHeaders,
              })
            : yield* itemWriteErrors.AuthenticationRequired();
        }),
      ).pipe(Effect.catchTags(itemWriteErrors)),
    ),
    folderChange("PUT"),
    folderChange("DELETE"),
    HttpRouter.add(
      "PUT",
      vaultBulkPath,
      secure(
        Effect.gen(function* () {
          const session = yield* requireSession;
          const input = yield* readItemBody(VaultBulkChange);
          if (input._tag === "None")
            return yield* jsonError(400, "Invalid vault selection.");
          const { items, keyId } = input.value;
          if (new Set(items.map(({ id }) => id)).size !== items.length)
            return yield* jsonError(400, "Select each item once.");
          const vault = yield* Effect.tryPromise(() =>
            readPersonalVault(db, session.subjectId),
          );
          if (!vault) return yield* noVault();
          if (vault.keyId !== keyId) return yield* staleVault();
          const result = yield* Effect.tryPromise(() =>
            changeItemSelection(
              db,
              browserAuthorization(vault, session),
              items,
              input.value,
            ),
          );
          switch (result.status) {
            case "updated":
              if (input.value.kind === "purge")
                scheduleAttachmentCleanup(env, defer);
              return yield* HttpServerResponse.schemaJson(
                Schema.Array(VaultItem),
              )(result.items.map(projectItem), { headers: privateHeaders });
            case "unauthorized":
              return yield* itemWriteErrors.AuthenticationRequired();
            case "not_found":
              return yield* jsonError(
                404,
                "An item or folder is unavailable. Reload your vault.",
              );
            case "conflict":
              return yield* jsonError(
                409,
                "The selected items changed. Reload your vault.",
              );
          }
        }),
      ).pipe(Effect.catchTags(itemWriteErrors)),
    ),
  );
};
