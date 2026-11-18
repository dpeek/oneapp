import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import { ByteSize, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  CreateVaultItem,
  EditVaultItem,
  hostUriMatch,
  vaultItemBodyLimit,
  VaultItem,
  VaultItemId,
  vaultItemsPath,
  VaultLifecycleAction,
  VaultLifecycleChange,
  VaultSnapshot,
} from "../../vault-items-contract.ts";
import { itemContent, validateDetails } from "../../vault-item-content.ts";
import { jsonError, privateHeaders } from "../api-response.ts";
import { AppAuth, type authHttp } from "../auth.ts";
import {
  changePersonalItem,
  createPersonalItem,
  editPersonalItem,
  editPersonalLogin,
  type PersonalItem,
  type PersonalVault,
  readPersonalItem,
  readPersonalItems,
  readPersonalVault,
} from "./personal.ts";

const itemFields = (item: PersonalItem) => ({
  id: item.id,
  name: item.name,
  wrappedKey: item.wrappedKey,
  notes: item.details.notes ?? null,
  requiresMasterPassword: item.details.reprompt === 1,
  revision: item.revisionAt,
  details: item.details,
});

const projectItem = (item: PersonalItem) => {
  if (item.type !== 1) return { ...itemFields(item), type: item.type };
  const { username, password, uris } = item.details.credentials;
  return {
    ...itemFields(item),
    type: item.type,
    username: username ?? null,
    password: password ?? null,
    uris: (uris ?? []).flatMap(({ uri }) => (uri === null ? [] : [uri])),
  };
};

const authorizedBrowserVault = `
  SELECT v.id, v.revision_at
  FROM personal_vaults v
  JOIN accounts a ON a.id = v.owner_id AND a.active = 1
  JOIN oneapp_auth_sessions s ON s.subject_id = a.id AND s.security_revision = a.security_revision
  WHERE v.id = ? AND v.key_id = ? AND a.id = ? AND a.security_revision = ?
    AND s.session_id = ? AND s.expires_at > ? AND s.absolute_expires_at > ?
`;

const requireSession = Effect.flatMap(AppAuth, (auth) => auth.requireSession);
const browserAuthorization = (
  vault: PersonalVault,
  session: Effect.Success<typeof requireSession>,
) => ({
  query: authorizedBrowserVault,
  parameters: (now: number) => [
    vault.id,
    vault.keyId,
    session.subjectId,
    session.securityRevision,
    session.sessionId,
    now,
    now,
  ],
});

const readItemBody = <A>(schema: Schema.ConstraintDecoder<A>) =>
  HttpServerRequest.schemaBodyJson(schema, { onExcessProperty: "error" }).pipe(
    Effect.provideService(
      HttpServerRequest.MaxBodySize,
      ByteSize.bytes(vaultItemBodyLimit),
    ),
    Effect.option,
  );
const itemWriteErrors = {
  AuthenticationRequired: () => jsonError(401, "Sign in to save a vault item."),
  HookDenied: () => jsonError(403, "Request not allowed."),
  UnknownError: () => jsonError(503, "Could not save your vault item."),
};
const noVault = () => jsonError(404, "Set up your password vault first.");
const staleVault = () =>
  jsonError(409, "Unlock your vault again to save this item.");
const isItemId = Schema.is(VaultItemId);
const isLifecycleAction = Schema.is(VaultLifecycleAction);

const changeResponse = (
  result: Awaited<ReturnType<typeof changePersonalItem>>,
  item = "item",
) => {
  switch (result.status) {
    case "updated":
      return HttpServerResponse.schemaJson(VaultItem)(
        projectItem(result.item),
        {
          headers: privateHeaders,
        },
      );
    case "unauthorized":
      return itemWriteErrors.AuthenticationRequired();
    case "not_found":
    case "type_mismatch":
      return jsonError(404, "Vault item not found.");
    case "conflict":
      return jsonError(409, `This ${item} has changed.`);
    case "trashed":
      return jsonError(409, `This ${item} is in Trash.`);
  }
};

export const vaultItemRoutes = (
  http: ReturnType<typeof authHttp>,
  db: WorkerEnv["DB"],
) =>
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      vaultItemsPath,
      Effect.gen(function* () {
        const session = yield* requireSession;
        const vault = yield* Effect.tryPromise(() =>
          readPersonalVault(db, session.subjectId),
        );
        if (!vault) return yield* noVault();
        const items = yield* Effect.tryPromise(() =>
          readPersonalItems(db, vault.id),
        );
        return yield* HttpServerResponse.schemaJson(VaultSnapshot)(
          {
            keyId: vault.keyId,
            wrappedKey: vault.wrappedKey,
            kdfSalt: vault.kdfSalt,
            kdfIterations: vault.kdfIterations,
            items: items
              .filter(({ deletedAt }) => deletedAt === null)
              .map(projectItem),
            trash: items
              .filter(({ deletedAt }) => deletedAt !== null)
              .map(projectItem),
          },
          { headers: privateHeaders },
        );
      }).pipe(
        Effect.catchTags({
          AuthenticationRequired: () =>
            jsonError(401, "Sign in to open your vault."),
          UnknownError: () => jsonError(503, "Could not load your vault."),
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      `${vaultItemsPath}/:id`,
      Effect.gen(function* () {
        const session = yield* requireSession;
        const { id } = yield* HttpRouter.params;
        if (!isItemId(id))
          return yield* jsonError(404, "Vault item not found.");
        const vault = yield* Effect.tryPromise(() =>
          readPersonalVault(db, session.subjectId),
        );
        if (!vault) return yield* noVault();
        const item = yield* Effect.tryPromise(() =>
          readPersonalItem(db, vault.id, id),
        );
        if (!item) return yield* jsonError(404, "Vault item not found.");
        return yield* HttpServerResponse.schemaJson(VaultItem)(
          projectItem(item),
          { headers: privateHeaders },
        );
      }).pipe(Effect.catchTags(itemWriteErrors)),
    ),
    HttpRouter.add(
      "POST",
      vaultItemsPath,
      http
        .protect(
          Effect.gen(function* () {
            const session = yield* requireSession;
            const input = yield* readItemBody(CreateVaultItem);
            if (input._tag === "None")
              return yield* jsonError(400, "Encrypted vault item is invalid.");
            const { keyId, name, wrappedKey } = input.value;
            if (
              "details" in input.value &&
              !validateDetails(input.value.type, input.value.details)
            )
              return yield* jsonError(400, "Encrypted vault item is invalid.");
            const vault = yield* Effect.tryPromise(() =>
              readPersonalVault(db, session.subjectId),
            );
            if (!vault) return yield* noVault();
            if (keyId !== vault.keyId) return yield* staleVault();
            const saved = yield* Effect.tryPromise(() =>
              createPersonalItem(
                db,
                vault.id,
                browserAuthorization(vault, session),
                "details" in input.value
                  ? {
                      name,
                      wrappedKey,
                      ...itemContent(input.value.type, input.value.details),
                    }
                  : input.value.type === 1
                    ? {
                        type: 1,
                        name,
                        wrappedKey,
                        details: {
                          credentials: {
                            username: input.value.username,
                            password: input.value.password,
                            uris: input.value.website
                              ? [
                                  {
                                    ...input.value.website,
                                    match: hostUriMatch,
                                  },
                                ]
                              : [],
                          },
                        },
                      }
                    : {
                        type: 2,
                        name,
                        wrappedKey,
                        details: { notes: input.value.notes },
                      },
              ),
            );
            if (!saved) return yield* staleVault();
            if (saved.deletedAt !== null)
              return yield* jsonError(409, "This item is in Trash.");
            return yield* HttpServerResponse.schemaJson(VaultItem)(
              projectItem(saved),
              { status: 201, headers: privateHeaders },
            );
          }),
        )
        .pipe(Effect.catchTags(itemWriteErrors)),
    ),
    HttpRouter.add(
      "PUT",
      `${vaultItemsPath}/:id`,
      http
        .protect(
          Effect.gen(function* () {
            const session = yield* requireSession;
            const { id } = yield* HttpRouter.params;
            if (!isItemId(id))
              return yield* jsonError(400, "Invalid vault item ID.");
            const input = yield* readItemBody(EditVaultItem);
            if (input._tag === "None")
              return yield* jsonError(400, "Encrypted vault item is invalid.");
            const { keyId, ...edit } = input.value;
            if ("details" in edit && !validateDetails(edit.type, edit.details))
              return yield* jsonError(400, "Encrypted vault item is invalid.");
            const vault = yield* Effect.tryPromise(() =>
              readPersonalVault(db, session.subjectId),
            );
            if (!vault) return yield* noVault();
            if (keyId !== vault.keyId) return yield* staleVault();
            const authorization = browserAuthorization(vault, session);
            const result = yield* Effect.tryPromise(() =>
              "details" in edit
                ? editPersonalItem(db, authorization, id, {
                    ...edit,
                    keepPasswordHistory: true,
                  })
                : edit.type === 1
                  ? editPersonalLogin(db, authorization, id, edit)
                  : changePersonalItem(db, authorization, id, {
                      kind: "edit_note",
                      ...edit,
                    }),
            );
            return yield* changeResponse(
              result,
              edit.type === 1
                ? "login"
                : (edit.type ?? 2) === 2
                  ? "note"
                  : "item",
            );
          }),
        )
        .pipe(Effect.catchTags(itemWriteErrors)),
    ),
    HttpRouter.add(
      "PUT",
      `${vaultItemsPath}/:id/:action`,
      http
        .protect(
          Effect.gen(function* () {
            const session = yield* requireSession;
            const { id, action } = yield* HttpRouter.params;
            if (!isItemId(id) || !isLifecycleAction(action))
              return yield* jsonError(404, "Vault item action not found.");
            const input = yield* readItemBody(VaultLifecycleChange);
            if (input._tag === "None")
              return yield* jsonError(400, "Vault item change is invalid.");
            const { keyId, expectedRevision } = input.value;
            const vault = yield* Effect.tryPromise(() =>
              readPersonalVault(db, session.subjectId),
            );
            if (!vault) return yield* noVault();
            if (keyId !== vault.keyId) return yield* staleVault();
            const result = yield* Effect.tryPromise(() =>
              changePersonalItem(db, browserAuthorization(vault, session), id, {
                kind: action === "trash" ? "delete" : "restore",
                expectedRevision,
              }),
            );
            return yield* changeResponse(result);
          }),
        )
        .pipe(Effect.catchTags(itemWriteErrors)),
    ),
  );
