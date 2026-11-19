import { digest } from "../digest.ts";
import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import { Schema } from "effect";
import {
  bitwardenAuthorizePath,
  bitwardenConnectorPath,
  bitwardenSignInUrl,
  bitwardenTokenPath,
} from "../../bitwarden-connection.ts";
import { BitwardenDeviceId } from "../../bitwarden-device-contract.ts";
import { contentType, error, json, readBody } from "./http.ts";
import { isManagementPath, manageVault } from "./management.ts";
import {
  bitwardenAttachments,
  isAttachmentPath,
  transferDownload,
} from "./attachments.ts";
import {
  hasAttachmentStore,
  scheduleAttachmentCleanup,
} from "../vault/attachments.ts";
import { readFolder, readFolders } from "../vault/folders.ts";
import { privateHeaders } from "../api-response.ts";
import {
  type PersonalVault,
  readPersonalItem,
  readPersonalItems,
  readPersonalVault,
} from "../vault/personal.ts";
import { decodeItem } from "./cipher-request.ts";
import {
  approveAuthorization,
  type BrowserIdentity,
  changePersonalItem,
  editPersonalItem,
  deviceAuthorization,
  readDeviceByAccess,
  redeemAuthorization,
  refreshDevice,
  savePersonalItem,
  startAuthorization,
} from "./store.ts";
import {
  type BitwardenClient,
  bitwardenClients,
  bitwardenScope,
  randomSecret,
} from "./tokens.ts";
import * as Wire from "./wire.ts";

const connectorScript = "/identity/oneapp-connector.js";
const ciphersPath = "/api/ciphers";
const cipherItemPath =
  /^\/api\/ciphers\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(delete|restore|details))?$/u;
const apiPaths = [
  "/api/config",
  ciphersPath,
  "/api/sync",
  "/api/accounts/profile",
  "/api/accounts/keys",
  "/api/accounts/revision-date",
];
export const isBitwardenPath = (path: string) =>
  path === bitwardenConnectorPath ||
  path.startsWith("/identity/") ||
  path.startsWith("/notifications/") ||
  apiPaths.includes(path) ||
  cipherItemPath.test(path) ||
  isManagementPath(path) ||
  isAttachmentPath(path);

const html = (body: string, status = 200, form = false) =>
  new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Bitwarden to OneApp</title><main>${body}</main></html>`,
    {
      status,
      headers: {
        ...privateHeaders,
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": form ? "same-origin" : "no-referrer",
        "content-security-policy":
          "default-src 'none'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      },
    },
  );
const redirect = (location: URL) =>
  new Response(null, {
    status: 303,
    headers: { ...privateHeaders, location: location.href },
  });
const clientState = {
  browser: /^[a-zA-Z0-9]{64}:clientId=browser$/u,
  desktop: /^[a-zA-Z0-9]{64}$/u,
};
const isClient = Schema.is(Schema.Literals(bitwardenClients));
const callbackFor = (origin: string, client: BitwardenClient) =>
  new URL(
    client === "desktop" ? "bitwarden://sso-callback" : bitwardenConnectorPath,
    origin,
  );
const secretShape = /^[a-zA-Z0-9_-]{43}$/u;
const verifierShape = /^[a-zA-Z0-9._~-]{43,128}$/u;
const isDeviceId = Schema.is(BitwardenDeviceId);
const deviceNameShape = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,63}$/u;

const readForm = async (request: Request) => {
  if (contentType(request) !== "application/x-www-form-urlencoded") return null;
  const body = await readBody(request, 4096);
  return body === null ? null : new URLSearchParams(body);
};

const itemChangeResponse = (
  result: Awaited<ReturnType<typeof changePersonalItem>>,
  empty = false,
) => {
  switch (result.status) {
    case "updated":
      return empty
        ? new Response(null, { status: 204, headers: privateHeaders })
        : json(Wire.cipher(result.item));
    case "unauthorized":
      return error("invalid_token", 401);
    case "not_found":
      return error("cipher_not_found", 404);
    case "type_mismatch":
      return error("invalid_cipher", 400);
    case "conflict":
      return json(
        {
          error: "stale_cipher",
          message:
            "This item has changed. Sync your vault, then reopen the item and try again.",
        },
        409,
      );
    case "trashed":
      return json(
        {
          error: "cipher_trashed",
          message:
            "This item is in Trash. Sync your vault and restore it before editing.",
        },
        409,
      );
  }
};

const writeItem = async (
  request: Request,
  db: WorkerEnv["DB"],
  vault: PersonalVault,
  accessDigest: string,
  cipherId: string | undefined,
) => {
  if (contentType(request) !== "application/json")
    return error("invalid_request");
  const body = await readBody(request, 128 * 1024);
  const item = body === null ? null : decodeItem(body, cipherId !== undefined);
  if (!item || (item.encryptedFor != null && item.encryptedFor !== vault.id))
    return error("invalid_cipher");
  if (item.encryptedByKeyId != null && item.encryptedByKeyId !== vault.keyId)
    return error("stale_vault_key", 409);
  if (item.folderId != null && !(await readFolder(db, vault.id, item.folderId)))
    return error("folder_not_found", 404);
  if (!cipherId) {
    if (item.attachmentIds.length) return error("invalid_cipher");
    const saved = await savePersonalItem(db, accessDigest, vault, item);
    return saved ? json(Wire.cipher(saved)) : error("invalid_token", 401);
  }

  const revision = Date.parse(item.lastKnownRevisionDate ?? "");
  if (
    !Number.isFinite(revision) ||
    new Date(revision).toISOString() !== item.lastKnownRevisionDate
  )
    return json(
      {
        error: "invalid_cipher_revision",
        message:
          "Sync your vault to get the current version, then reopen the item and try again.",
      },
      400,
    );
  return itemChangeResponse(
    await editPersonalItem(db, accessDigest, vault, cipherId, {
      ...item,
      expectedRevision: revision,
    }),
  );
};

const authorize = async (
  request: Request,
  url: URL,
  env: WorkerEnv,
  browserIdentity: () => Promise<BrowserIdentity | null>,
) => {
  if (request.method === "GET") {
    const clientId = url.searchParams.get("client_id");
    const state = url.searchParams.get("state") ?? "";
    const challenge = url.searchParams.get("code_challenge") ?? "";
    if (
      !isClient(clientId) ||
      url.searchParams.get("redirect_uri") !==
        callbackFor(env.APP_ORIGIN, clientId).href ||
      url.searchParams.get("response_type") !== "code" ||
      url.searchParams.get("scope") !== bitwardenScope ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      !clientState[clientId].test(state) ||
      !secretShape.test(challenge)
    )
      return error("invalid_request");

    const browser = await browserIdentity();
    if (!browser) return redirect(bitwardenSignInUrl(url));
    const vault = await readPersonalVault(env.DB, browser.ownerId);
    if (!vault)
      return html(
        "<h1>Vault setup required</h1><p>This OneApp account does not have a personal vault yet.</p>",
        409,
      );
    const consent = randomSecret();
    await startAuthorization(
      env.DB,
      browser,
      vault.id,
      clientId,
      state,
      challenge,
      await digest(consent),
    );
    return html(
      `<h1>Connect Bitwarden to OneApp</h1><form method="post" action="${bitwardenAuthorizePath}">
      <input type="hidden" name="approval" value="${consent}"><button type="submit">Connect vault</button></form>`,
      200,
      true,
    );
  }
  if (request.method !== "POST") return error("method_not_allowed", 405);
  if (request.headers.get("origin") !== env.APP_ORIGIN)
    return error("invalid_origin", 403);
  const consent = (await readForm(request))?.get("approval") ?? "";
  if (!secretShape.test(consent)) return error("invalid_request");
  const browser = await browserIdentity();
  if (!browser) return error("access_denied", 401);
  const code = randomSecret();
  const approval = await approveAuthorization(
    env.DB,
    browser,
    await digest(consent),
    await digest(code),
  );
  if (!approval) return error("invalid_request");
  const callback = callbackFor(env.APP_ORIGIN, approval.clientId);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", approval.state);
  return redirect(callback);
};

const token = async (request: Request, env: WorkerEnv) => {
  if (request.method !== "POST") return error("method_not_allowed", 405);
  const form = await readForm(request);
  if (!form) return error("invalid_request");
  const clientId = form.get("client_id");
  if (!isClient(clientId)) return error("invalid_client");
  const type = form.get("grant_type");

  if (type === "authorization_code") {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const deviceId =
      form.get("deviceIdentifier") ?? form.get("device_identifier");
    const deviceName =
      (form.get("deviceName") ?? form.get("device_name"))?.trim() ?? "";
    if (
      form.get("redirect_uri") !== callbackFor(env.APP_ORIGIN, clientId).href ||
      !secretShape.test(code) ||
      !verifierShape.test(verifier) ||
      !isDeviceId(deviceId)
    )
      return error("invalid_grant");
    const issued = await redeemAuthorization(
      env.DB,
      env.APP_ORIGIN,
      env.AUTH_SECRET,
      clientId,
      await digest(code),
      await digest(verifier),
      {
        id: deviceId,
        name: deviceNameShape.test(deviceName) ? deviceName : null,
      },
    );
    if (!issued) return error("invalid_grant");
    const vault = await readPersonalVault(env.DB, issued.ownerId);
    if (!vault || vault.id !== issued.identity.vaultId)
      return error("invalid_grant");
    return json({ ...issued.grant, ...Wire.unlockOptions(vault) });
  }

  if (type === "refresh_token") {
    const refresh = form.get("refresh_token") ?? "";
    if (!secretShape.test(refresh)) return error("invalid_grant");
    const grant = await refreshDevice(
      env.DB,
      env.APP_ORIGIN,
      env.AUTH_SECRET,
      clientId,
      await digest(refresh),
    );
    return grant ? json(grant) : error("invalid_grant");
  }
  return error("unsupported_grant_type");
};

const connector = `
const params = new URLSearchParams(location.search);
const code = params.get("code");
const state = params.get("state");
if (/^[a-zA-Z0-9_-]{43}$/.test(code ?? "") && /^[a-zA-Z0-9]{64}:clientId=browser$/.test(state ?? "")) {
  history.replaceState(null, "", location.pathname);
  window.postMessage({ command: "authResult", code, state, lastpass: false }, location.origin);
}
`;

export const bitwardenFetch = async (
  request: Request,
  url: URL,
  env: WorkerEnv,
  browserIdentity: () => Promise<BrowserIdentity | null>,
  defer: (work: Promise<unknown>) => void,
) => {
  const path = url.pathname;
  if (url.origin !== env.APP_ORIGIN) return error("invalid_origin", 403);
  if (path === bitwardenAuthorizePath || path === bitwardenTokenPath) {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (!(await env.AUTH_LIMIT.limit({ key: `bitwarden:${ip}` })).success)
      return Response.json(
        { error: "rate_limit_exceeded" },
        {
          status: 429,
          headers: { ...privateHeaders, "retry-after": "10" },
        },
      );
    return path === bitwardenAuthorizePath
      ? authorize(request, url, env, browserIdentity)
      : token(request, env);
  }

  if (path === bitwardenConnectorPath || path === connectorScript) {
    if (request.method !== "GET") return error("method_not_allowed", 405);
    return path === bitwardenConnectorPath
      ? html(
          `<p>Return to the Bitwarden extension.</p><script src="${connectorScript}"></script>`,
        )
      : new Response(connector, {
          headers: {
            ...privateHeaders,
            "content-type": "text/javascript; charset=utf-8",
          },
        });
  }

  const isAttachment = isAttachmentPath(path);
  if (isAttachment) {
    const download = await transferDownload(request, url, env);
    if (download) return download;
  }

  const [, cipherId, lifecycle] = cipherItemPath.exec(path) ?? [];
  const management = isManagementPath(path, request.method);
  if (!management && !isAttachment && !cipherId && !apiPaths.includes(path))
    return error("unsupported_endpoint", 404);
  const methods = cipherId
    ? lifecycle === "details"
      ? ["GET"]
      : lifecycle
        ? ["PUT"]
        : ["GET", "PUT"]
    : path === ciphersPath
      ? ["GET", "POST"]
      : ["GET"];
  if (!management && !isAttachment && !methods.includes(request.method))
    return error("method_not_allowed", 405);
  if (path === "/api/config") return json(Wire.config(env.APP_ORIGIN));
  const access = request.headers
    .get("authorization")
    ?.match(/^Bearer ([\w.-]{1,4096})$/iu)?.[1];
  if (!access) return error("invalid_token", 401);
  const accessDigest = await digest(access);
  const device = await readDeviceByAccess(env.DB, accessDigest);
  if (!device) return error("invalid_token", 401);
  const vault = await readPersonalVault(env.DB, device.ownerId);
  if (!vault || vault.id !== device.vaultId) return error("invalid_token", 401);
  if (isAttachment)
    return bitwardenAttachments(
      request,
      path,
      env,
      vault,
      deviceAuthorization(vault, accessDigest),
      device.id,
      defer,
    );
  if (management) {
    const result = await manageVault(
      request,
      path,
      env.DB,
      vault,
      deviceAuthorization(vault, accessDigest),
    );
    if (request.method === "DELETE" && result.ok)
      scheduleAttachmentCleanup(env, defer);
    return result;
  }
  if (cipherId && (lifecycle === "delete" || lifecycle === "restore"))
    return itemChangeResponse(
      await changePersonalItem(env.DB, accessDigest, vault, cipherId, {
        kind: lifecycle,
      }),
      lifecycle === "delete",
    );
  if (request.method === "GET" && cipherId) {
    const item = await readPersonalItem(env.DB, vault.id, cipherId);
    return item ? json(Wire.cipher(item)) : error("cipher_not_found", 404);
  }
  if (request.method === "GET" && path === ciphersPath)
    return json(
      Wire.list((await readPersonalItems(env.DB, vault.id)).map(Wire.cipher)),
    );
  if (cipherId || path === ciphersPath)
    return writeItem(request, env.DB, vault, accessDigest, cipherId);

  switch (path) {
    case "/api/sync":
      const [items, folders] = await Promise.all([
        readPersonalItems(env.DB, vault.id),
        readFolders(env.DB, vault.id),
      ]);
      return json(
        Wire.sync(vault, device, items, folders, hasAttachmentStore(env)),
      );
    case "/api/accounts/profile":
      return json(Wire.profile(vault, device, hasAttachmentStore(env)));
    case "/api/accounts/keys":
      return json(Wire.keys(vault));
    case "/api/accounts/revision-date":
      return json(vault.revisionAt);
    default:
      return error("unsupported_endpoint", 404);
  }
};
