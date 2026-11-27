import { defaultServerUrl, vaultPath } from "@orumai/core";
import {
  extensionVaultPath,
  type ExtensionVaultLogin,
  ExtensionVaultSnapshot,
} from "@orumai/core/vault";
import {
  decryptVaultText,
  unlockVault,
  unwrapVaultKey,
  type VaultKey,
} from "@orumai/core/vault-crypto";
import {
  buttonClassName,
  createAlert,
  createField,
  inputClassName,
} from "@orumai/ui";
import { Schema } from "effect";
import {
  connect,
  connectionStatus,
  readConnection,
  serverRequest,
} from "./access.ts";
import { httpsPage, matchesLoginUri } from "./vault-matching.ts";

const scope = "vault-read";
const decodeSnapshot = Schema.decodeUnknownSync(ExtensionVaultSnapshot);

type Field = "username" | "password";
type Match = {
  item: ExtensionVaultLogin;
  title: string;
  username: string | null;
};

type Unlocked = {
  connectionId: string;
  keyId: string;
  key: VaultKey;
  matches: readonly Match[];
};

type State =
  | {
      status:
        | "checking"
        | "pending"
        | "disconnected"
        | "revoked"
        | "locked"
        | "unavailable"
        | "uninitialized";
    }
  | { status: "unlocked"; vault: Unlocked };

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};

const action = (label: string, click?: () => void, secondary = false) => {
  const button = element("button", label);
  button.type = click ? "button" : "submit";
  button.dataset.slot = "button";
  button.className = buttonClassName({
    variant: secondary ? "outline" : "primary",
    size: "sm",
  });
  if (click) button.addEventListener("click", click);
  return button;
};

const currentPage = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return httpsPage(tab?.url);
};

const matchingKey = async (
  item: ExtensionVaultLogin,
  key: VaultKey,
  page: URL,
) => {
  if (!item.uris.some(({ uri }) => uri !== null)) return null;
  const itemKey = await unwrapVaultKey(item.wrappedKey, key);
  for (const { uri, match } of item.uris) {
    if (uri === null || match === 4 || match === 5) continue;
    if (matchesLoginUri(page, await decryptVaultText(uri, itemKey), match))
      return itemKey;
  }
  return null;
};

async function findMatches(
  snapshot: ExtensionVaultSnapshot,
  key: VaultKey,
  page: URL,
) {
  const matches = await Promise.allSettled(
    snapshot.logins.map(async (item): Promise<Match | null> => {
      if (item.username === null && item.password === null) return null;
      const itemKey = await matchingKey(item, key, page);
      if (!itemKey) return null;
      return {
        item,
        title: (await decryptVaultText(item.name, itemKey)) || "Untitled login",
        username:
          item.requiresMasterPassword || item.username === null
            ? null
            : await decryptVaultText(item.username, itemKey),
      };
    }),
  );
  return {
    matches: matches
      .flatMap((result) =>
        result.status === "fulfilled" && result.value ? [result.value] : [],
      )
      .sort((a, b) => a.title.localeCompare(b.title)),
    incomplete: matches.some(({ status }) => status === "rejected"),
  };
}

export function mountVaultPopup(root: HTMLElement) {
  const controller = new AbortController();
  const { signal } = controller;
  let state: State = { status: "checking" };
  let prompt: { id: string; field: Field } | undefined;
  let busy = false;
  let notice = "";
  let error = "";

  const lock = () => {
    state = { status: "locked" };
    prompt = undefined;
    notice = "";
    error = "";
    render();
  };

  window.addEventListener(
    "pagehide",
    () => {
      controller.abort();
      state = { status: "locked" };
      prompt = undefined;
      root.replaceChildren();
    },
    { once: true },
  );

  const run = async (work: () => Promise<void>, failure: string) => {
    if (busy || signal.aborted) return;
    busy = true;
    error = "";
    notice = "";
    root.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
    root.querySelectorAll("input").forEach((input) => {
      input.readOnly = true;
    });
    root.setAttribute("aria-busy", "true");
    try {
      await work();
    } catch {
      error = failure;
    } finally {
      busy = false;
      if (!signal.aborted) {
        render();
        if (prompt || (state.status === "locked" && error))
          root.querySelector("input")?.focus();
      }
    }
  };

  const check = () =>
    run(async () => {
      state = { status: "unavailable" };
      const status = await connectionStatus(signal, scope);
      signal.throwIfAborted();
      state = { status: status === "connected" ? "locked" : status };
    }, "Could not check vault access. Try again.");

  const approve = () =>
    run(async () => {
      await connect(scope);
      signal.throwIfAborted();
      state = { status: "pending" };
    }, "Could not open the approval page. Try again.");

  const readSnapshot = async () => {
    const connection = await readConnection(scope);
    const response =
      connection &&
      (await serverRequest(extensionVaultPath, connection.secret, {}, signal));
    signal.throwIfAborted();
    if (!response || response.status === 401 || response.status === 404) {
      state = {
        status: response?.status === 404 ? "uninitialized" : "revoked",
      };
      prompt = undefined;
      return null;
    }
    if (!response.ok) throw new Error("Could not read vault");
    return {
      connectionId: connection.id,
      snapshot: decodeSnapshot(await response.json()),
    };
  };

  const unlock = (password: string) =>
    run(async () => {
      const access = await readSnapshot();
      if (!access) return;
      let key: VaultKey;
      try {
        key = await unlockVault(password, access.snapshot);
      } catch {
        error = "Check your vault master password and try again.";
        return;
      }
      const page = await currentPage();
      const { matches, incomplete } = page
        ? await findMatches(access.snapshot, key, page)
        : { matches: [], incomplete: false };
      signal.throwIfAborted();
      state = {
        status: "unlocked",
        vault: {
          key,
          connectionId: access.connectionId,
          keyId: access.snapshot.keyId,
          matches,
        },
      };
      if (incomplete) error = "Some vault logins could not be read.";
    }, "Could not load your vault. Try again.");

  const copy = (id: string, field: Field, password?: string) =>
    run(async () => {
      if (state.status !== "unlocked") return;
      const { vault } = state;
      const access = await readSnapshot();
      if (!access) return;
      if (
        vault.connectionId !== access.connectionId ||
        vault.keyId !== access.snapshot.keyId
      ) {
        state = { status: "locked" };
        prompt = undefined;
        error = "Your vault changed. Unlock it again.";
        return;
      }
      const listed = vault.matches.find(({ item }) => item.id === id)?.item;
      const item = access.snapshot.logins.find((item) => item.id === id);
      const page = await currentPage();
      const itemKey =
        listed && item && item.revision === listed.revision && page
          ? await matchingKey(item, vault.key, page)
          : null;
      if (!item || !itemKey || item[field] === null) {
        state = { status: "locked" };
        prompt = undefined;
        error =
          "This login changed or no longer matches this tab. Unlock the vault to refresh matches.";
        return;
      }
      if (item.requiresMasterPassword) {
        if (password === undefined) {
          prompt = { id, field };
          return;
        }
        try {
          await unlockVault(password, access.snapshot);
        } catch {
          error = "Check your vault master password and try again.";
          return;
        }
      }
      const value = await decryptVaultText(item[field], itemKey);
      // A same-origin navigation can invalidate an exact or prefix match while unlocking.
      const latestPage = await currentPage();
      signal.throwIfAborted();
      if (latestPage?.href !== page?.href) {
        state = { status: "locked" };
        prompt = undefined;
        error = "The active tab changed. Unlock the vault to refresh matches.";
        return;
      }
      await navigator.clipboard.writeText(value);
      prompt = undefined;
      notice = field === "username" ? "Username copied." : "Password copied.";
    }, `Could not copy the ${field}. Try again.`);

  const passwordForm = (label: string, submit: (password: string) => void) => {
    const form = element("form");
    form.className = "vault-password";
    form.method = "post";
    const input = element("input");
    input.type = "password";
    input.id = "vault-master-password";
    input.autocomplete = "off";
    input.required = true;
    input.dataset.slot = "input";
    input.className = inputClassName;
    form.append(
      createField({
        label: "Vault master password",
        content: input,
        control: input,
      }),
      action(label),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (busy) return;
      const password = input.value;
      form.reset();
      submit(password);
    });
    return form;
  };

  const loginRow = ({ item, title, username }: Match) => {
    const row = element("li");
    row.className = "vault-login";
    const actions = element("div");
    actions.className = "vault-copy-actions";
    for (const field of ["username", "password"] as const) {
      if (item[field] === null) continue;
      const button = action(
        `Copy ${field}`,
        () => {
          void copy(item.id, field);
        },
        true,
      );
      button.setAttribute("aria-label", `Copy ${field} for ${title}`);
      actions.append(button);
    }
    row.append(element("h3", title));
    if (username) row.append(element("p", username));
    row.append(actions);
    return row;
  };

  function render() {
    root.removeAttribute("aria-busy");
    const heading = element("h2", "Vault logins");
    heading.id = "vault-popup-heading";
    root.replaceChildren(heading);
    switch (state.status) {
      case "checking":
        root.append(element("p", "Checking vault access…"));
        break;
      case "pending":
        root.append(
          element("p", "Approve read-only vault access in the Orumai tab."),
          action("Check vault access", check),
        );
        break;
      case "disconnected":
        root.append(
          element("p", "Connect your vault to find logins for this tab."),
          action("Connect vault", approve),
        );
        break;
      case "revoked":
        root.append(
          element("p", "Vault access expired or was revoked."),
          action("Reconnect vault", approve),
        );
        break;
      case "unavailable":
        root.append(action("Retry vault access", check));
        break;
      case "uninitialized": {
        const link = element("a", "Open Vault in Orumai");
        link.href = new URL(vaultPath, defaultServerUrl).href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        root.append(
          element("p", "Set up your vault in Orumai to use it here."),
          link,
          action("Check vault access", check, true),
        );
        break;
      }
      case "locked":
        root.append(
          element("p", "Your vault is locked."),
          passwordForm("Unlock vault", unlock),
        );
        break;
      case "unlocked": {
        const { matches } = state.vault;
        const request = prompt;
        const match =
          request && matches.find(({ item }) => item.id === request.id);
        if (request && match) {
          root.append(
            element(
              "p",
              `Confirm your master password to copy the ${request.field} for ${match.title}.`,
            ),
            passwordForm(`Copy ${request.field}`, (password) =>
              copy(request.id, request.field, password),
            ),
            action(
              "Cancel",
              () => {
                prompt = undefined;
                error = "";
                render();
              },
              true,
            ),
          );
        } else if (matches.length) {
          const list = element("ul");
          list.className = "vault-logins";
          list.append(...matches.map(loginRow));
          root.append(list);
        } else {
          root.append(
            element(
              "p",
              "No matching logins for this tab. Logins can match on HTTPS pages.",
            ),
          );
        }
        root.append(action("Lock vault", lock, true));
        break;
      }
    }
    if (notice)
      root.append(
        createAlert({
          message: notice,
          severity: "success",
          announcement: "status",
        }),
      );
    if (error)
      root.append(
        createAlert({
          message: error,
          severity: "error",
          announcement: "alert",
        }),
      );
  }

  render();
  void check();
}
