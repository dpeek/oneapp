import { defaultServerUrl } from "@orumai/core";
import {
  currentExtensionPath,
  extensionApprovalHash,
  ExtensionRequestId,
  ExtensionSecret,
  type ExtensionScope,
  vaultExtensionApprovalHash,
} from "@orumai/core/extension-auth";
import { Schema } from "effect";
import { Base64Url } from "effect/encoding";

const storageKey = (scope: ExtensionScope) =>
  scope === "links" ? "connection" : "vaultConnection";
const Connection = Schema.Struct({
  id: ExtensionRequestId,
  secret: ExtensionSecret,
  approvalTab: Schema.Int,
  pendingUntil: Schema.Int,
});
const isConnection = Schema.is(Connection);
export type Connection = typeof Connection.Type;

export async function readConnection(scope: ExtensionScope = "links") {
  const key = storageKey(scope);
  const connection = (await chrome.storage.local.get(key))[key];
  return isConnection(connection) ? connection : undefined;
}

export const clearConnection = (scope: ExtensionScope = "links") =>
  chrome.storage.local.remove(storageKey(scope));

export const serverRequest = (
  path: string,
  secret: string,
  init: RequestInit,
  signal: AbortSignal,
) => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${secret}`);
  return fetch(new URL(path, defaultServerUrl), {
    ...init,
    headers,
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal,
  });
};

export async function connect(scope: ExtensionScope = "links") {
  const key = storageKey(scope);
  const approvalHash =
    scope === "links" ? extensionApprovalHash : vaultExtensionApprovalHash;
  const tab = await chrome.tabs.create({ active: false, url: "about:blank" });
  if (tab.id === undefined) throw new Error("Could not open approval tab");
  const connection: Connection = {
    id: crypto.randomUUID(),
    secret: `one_ext_${Base64Url.encode(crypto.getRandomValues(new Uint8Array(32)))}`,
    approvalTab: tab.id,
    pendingUntil: Date.now() + 5 * 60 * 1000,
  };
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  await chrome.storage.local.set({ [key]: connection });
  try {
    await chrome.tabs.update(tab.id, {
      active: true,
      url: `${defaultServerUrl}/${approvalHash}${connection.id}`,
    });
  } catch (error) {
    await clearConnection(scope);
    throw error;
  }
}

type ConnectionStatus = "connected" | "disconnected" | "pending";
export function connectionStatus(
  signal: AbortSignal,
): Promise<ConnectionStatus>;
export function connectionStatus(
  signal: AbortSignal,
  scope: ExtensionScope,
): Promise<ConnectionStatus | "revoked">;
export async function connectionStatus(
  signal: AbortSignal,
  scope: ExtensionScope = "links",
) {
  const key = storageKey(scope);
  const connection = await readConnection(scope);
  if (!connection) return "disconnected";
  const response = await serverRequest(
    currentExtensionPath,
    connection.secret,
    {},
    signal,
  );
  if (response.status === 204) {
    if (connection.pendingUntil !== 0)
      await chrome.storage.local.set({
        [key]: { ...connection, pendingUntil: 0 },
      });
    return "connected";
  }
  if (response.status !== 401)
    throw new Error("Could not check extension access");
  if (Date.now() < connection.pendingUntil) return "pending";
  if (scope === "vault-read")
    return connection.pendingUntil === 0 ? "revoked" : "disconnected";
  await clearConnection(scope);
  return "disconnected";
}
