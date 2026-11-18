import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import { Schema } from "effect";
import {
  EncryptedVaultValue,
  VaultItemId,
} from "../../vault-items-contract.ts";
import {
  changeFolder,
  createFolder,
  readFolder,
  readFolders,
} from "../vault/folders.ts";
import { changeItemSelection } from "../vault/lifecycle.ts";
import {
  editPersonalItem,
  readPersonalItem,
  type PersonalVault,
  type VaultAuthorization,
} from "../vault/personal.ts";
import { vaultImportBytes } from "../../vault-transfer-contract.ts";
import { importPersonalVault } from "../vault/import.ts";
import { ImportPayload, parseImport } from "./import-request.ts";
import { empty, error, json, readJson } from "./http.ts";
import * as Wire from "./wire.ts";

const isId = Schema.is(VaultItemId);
const ciphers = "/api/ciphers";
const folders = "/api/folders";
const actionPath =
  /^\/api\/ciphers\/(?:([0-9a-f-]{36})\/)?(archive|unarchive|move|delete|restore|partial)$/u;
const cipherPath = /^\/api\/ciphers\/([0-9a-f-]{36})$/u;
const folderPath = /^\/api\/folders(?:\/([0-9a-f-]{36}))?$/u;

export const isManagementPath = (path: string, method?: string) =>
  path === "/api/ciphers/import" ||
  folderPath.test(path) ||
  (path === ciphers && method === "DELETE") ||
  (cipherPath.test(path) && method === "DELETE") ||
  (actionPath.test(path) &&
    (!method ||
      !/^\/api\/ciphers\/[0-9a-f-]{36}\/(delete|restore)$/u.test(path)));

const CipherIds = Schema.Array(VaultItemId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
);
const decodeSelection = Schema.is(Schema.Struct({ ids: CipherIds }));
const decodeMove = Schema.is(
  Schema.Struct({ ids: CipherIds, folderId: Schema.NullOr(VaultItemId) }),
);
const decodeFolder = Schema.is(Schema.Struct({ name: EncryptedVaultValue }));
const decodePartial = Schema.is(
  Schema.Struct({
    favorite: Schema.optionalKey(Schema.Boolean),
    folderId: Schema.optionalKey(Schema.NullOr(VaultItemId)),
  }),
);

export const manageVault = async (
  request: Request,
  path: string,
  db: WorkerEnv["DB"],
  vault: PersonalVault,
  authorization: VaultAuthorization,
) => {
  if (path === "/api/ciphers/import") {
    if (request.method !== "POST") return error("method_not_allowed", 405);
    const body = await readJson(request, vaultImportBytes);
    if (!Schema.is(ImportPayload)(body)) return error("invalid_import");
    const parsed = parseImport(body, vault);
    if ("error" in parsed)
      return json({ error: "invalid_import", message: parsed.error }, 400);
    return (await importPersonalVault(db, authorization, parsed.data))
      ? empty()
      : error("invalid_token", 401);
  }
  const folderMatch = folderPath.exec(path);
  const method = request.method;
  if (folderMatch) {
    const id = folderMatch[1];
    if (id && !isId(id)) return error("folder_not_found", 404);
    if (method === "GET") {
      if (!id)
        return json(
          Wire.list((await readFolders(db, vault.id)).map(Wire.folder)),
        );
      const folder = await readFolder(db, vault.id, id);
      return folder
        ? json(Wire.folder(folder))
        : error("folder_not_found", 404);
    }
    if (!id && method === "POST") {
      const body = await readJson(request, 128 * 1024);
      if (!decodeFolder(body)) return error("invalid_folder");
      const folder = await createFolder(db, authorization, body.name);
      return folder ? json(Wire.folder(folder)) : error("invalid_token", 401);
    }
    if (id && (method === "PUT" || method === "DELETE")) {
      const body =
        method === "PUT" ? await readJson(request, 128 * 1024) : null;
      if (method === "PUT" && !decodeFolder(body))
        return error("invalid_folder");
      const result = await changeFolder(
        db,
        authorization,
        id,
        decodeFolder(body)
          ? { kind: "rename", name: body.name }
          : { kind: "delete" },
      );
      if (result.status === "updated")
        return method === "DELETE" ? empty() : json(Wire.folder(result.folder));
      return result.status === "unauthorized"
        ? error("invalid_token", 401)
        : error("folder_not_found", 404);
    }
    return error("method_not_allowed", 405);
  }

  const [, itemId, action] = actionPath.exec(path) ?? [];
  const deletedId = cipherPath.exec(path)?.[1];
  if (method !== "PUT" && method !== "DELETE")
    return error("method_not_allowed", 405);
  if (action === "partial" && itemId && method === "PUT") {
    const body = await readJson(request, 4096);
    if (
      !decodePartial(body) ||
      (body.favorite === undefined && body.folderId === undefined)
    )
      return error("invalid_cipher");
    if (
      body.folderId != null &&
      !(await readFolder(db, vault.id, body.folderId))
    )
      return error("folder_not_found", 404);
    const item = await readPersonalItem(db, vault.id, itemId);
    if (!item) return error("cipher_not_found", 404);
    const result = await editPersonalItem(db, authorization, itemId, {
      type: item.type,
      name: item.name,
      details: body.favorite === undefined ? {} : { favorite: body.favorite },
      folderId: body.folderId,
      expectedRevision: item.revisionAt,
    });
    if (result.status === "updated") return json(Wire.cipher(result.item));
    if (result.status === "unauthorized") return error("invalid_token", 401);
    return error("stale_cipher", 409);
  }

  const kind =
    method === "DELETE" ? "purge" : action === "delete" ? "trash" : action;
  if (
    kind !== "purge" &&
    kind !== "trash" &&
    kind !== "restore" &&
    kind !== "archive" &&
    kind !== "unarchive" &&
    kind !== "move"
  )
    return error("unsupported_endpoint", 404);
  if (method === "DELETE" && path !== ciphers && !deletedId)
    return error("method_not_allowed", 405);
  const id = itemId ?? deletedId;
  if (id && !isId(id)) return error("cipher_not_found", 404);
  const body = id ? { ids: [id] } : await readJson(request, 8192);
  if (!decodeSelection(body) || new Set(body.ids).size !== body.ids.length)
    return error("invalid_cipher_selection");
  const change =
    kind === "move"
      ? decodeMove(body)
        ? ({ kind, folderId: body.folderId } as const)
        : null
      : ({ kind } as const);
  if (!change) return error("invalid_folder");
  const result = await changeItemSelection(
    db,
    authorization,
    body.ids.map((id) => ({ id })),
    change,
  );
  if (result.status === "unauthorized") return error("invalid_token", 401);
  if (result.status === "not_found")
    return error("cipher_or_folder_not_found", 404);
  if (result.status === "conflict") return error("invalid_cipher_state", 409);
  if (kind === "trash" || kind === "purge" || kind === "move") return empty();
  return json(
    id
      ? Wire.cipher(result.items[0]!)
      : Wire.list(result.items.map(Wire.cipher)),
  );
};
