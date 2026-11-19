import { Schema } from "effect";
import { CustomElement } from "foldkit";
import {
  decryptVaultText,
  encryptLogin,
  encryptNoteFields,
  encryptNewItem,
  encryptOptionalText,
  encryptSecureNote,
  encryptVaultText,
  encryptWebsite,
  unlockVault,
  unwrapVaultKey,
  type VaultKey,
} from "./vault-crypto.ts";
import {
  vaultItemBodyLimit,
  vaultBulkPath,
  VaultFolder,
  vaultFolderPath,
  vaultFoldersPath,
  type VaultBulkChange,
  VaultItem,
  vaultItemPath,
  vaultItemsPath,
  vaultLifecyclePath,
  type VaultLogin,
  VaultSecureNote,
  VaultSnapshot,
} from "./vault-items-contract.ts";
import {
  extraItemTypes,
  itemTypes,
  type ItemType,
} from "./vault-item-content.ts";
import {
  decryptItemDetails,
  linkedFieldLabel,
  uriMatchLabels,
  vaultItemEditor,
} from "./vault-item-editor.ts";
import {
  openPortableVault,
  readPortableVault,
  sealPortableVault,
  writePortableCsv,
  writePortableJson,
  writeProtectedExport,
} from "./vault-portable.ts";
import {
  vaultImportBytes,
  vaultImportPath,
} from "./vault-transfer-contract.ts";
import {
  encryptVaultAttachment,
  openVaultAttachment,
  removeVaultAttachment,
  uploadVaultAttachment,
} from "./vault-attachments.ts";
import type { AttachmentMetadata } from "./vault-attachment-contract.ts";
import { writeVaultZip } from "./vault-zip.ts";
import { vaultPasswordMaximum } from "./vault-setup-contract.ts";

export const vaultReader = CustomElement.define({
  tag: "oneapp-vault-reader",
  properties: {},
  events: {},
});

type Snapshot = typeof VaultSnapshot.Type;
type Item = Snapshot["items"][number];
type ListedItem = { item: Item; title: string | null; trashed: boolean };
type VaultView = "active" | "archive" | "trash";
const vaultViews = { active: "All items", archive: "Archive", trash: "Trash" };
const allItemTypes = [1, 2, ...extraItemTypes] as const;
type Folder = typeof VaultFolder.Type;
type ListedFolder = { folder: Folder; title: string };
type BulkAction = (typeof VaultBulkChange.Type)["kind"];
type EditTarget = { item: Item; title: string; cancel: () => void };
type NoteEdit = EditTarget & {
  item: typeof VaultSecureNote.Type;
  notes: string | null;
};
type LoginEdit = EditTarget & {
  item: typeof VaultLogin.Type;
  login: NonNullable<ItemDetails["login"]>;
};
type ItemField = readonly [
  label: string,
  input: HTMLInputElement | HTMLTextAreaElement,
];
type UnlockedVault = {
  parameters: Omit<Snapshot, "items" | "trash" | "folders">;
  key: VaultKey;
  entries: ListedItem[];
  folders: ListedFolder[];
};
type VaultWorkspace = {
  root: HTMLElement;
  tools: HTMLDetailsElement;
  filters: HTMLElement;
  views: HTMLButtonElement[];
  type: HTMLSelectElement;
  folder: HTMLSelectElement;
  listPane: HTMLElement;
  search: HTMLInputElement;
  newItem: HTMLButtonElement;
  status: HTMLElement;
  bulk: HTMLElement;
  results: HTMLElement;
  detail: HTMLElement;
};

const decodeSnapshot = Schema.decodeUnknownSync(VaultSnapshot);
const decodeItem = Schema.decodeUnknownSync(VaultItem);
const create = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
};
const action = (label: string, run: () => void) => {
  const button = create("button", label);
  button.type = "button";
  button.addEventListener("click", () => run());
  return button;
};
const menu = (label: string, ...buttons: (HTMLButtonElement | undefined)[]) => {
  const disclosure = create("details");
  disclosure.className = "vault-menu";
  const actions = create("div");
  for (const button of buttons) if (button) actions.append(button);
  actions.addEventListener("click", (event) => {
    if (event.target instanceof HTMLButtonElement) disclosure.open = false;
  });
  disclosure.append(create("summary", label), actions);
  return disclosure;
};
const alert = (message: string) => {
  const status = create("p", message);
  status.setAttribute("role", "alert");
  return status;
};
const statusMessage = (message: string) => {
  const status = create("p", message);
  status.setAttribute("role", "status");
  return status;
};
const itemField = ([label, input]: ItemField) => {
  const field = create("label", label);
  field.className = "vault-item-field";
  input.spellcheck = false;
  field.append(input);
  return field;
};

const passwordForm = (label: string, submit: (password: string) => void) => {
  const form = create("form");
  form.method = "post";
  const input = create("input");
  input.type = "password";
  input.required = true;
  input.maxLength = vaultPasswordMaximum;
  input.autocomplete = "off";
  const field = create("label", "Vault master password");
  field.className = "vault-password-field";
  field.append(input);
  const button = create("button", label);
  button.type = "submit";
  form.append(field, button);
  // The password stays out of native form submissions and the app's message history.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const password = input.value;
    form.reset();
    submit(password);
  });
  return form;
};

const readText = (ciphertext: string | null, key: VaultKey) =>
  ciphertext === null
    ? Promise.resolve(null)
    : decryptVaultText(ciphertext, key);

const readTitle = async (item: Item, userKey: VaultKey) =>
  decryptVaultText(item.name, await unwrapVaultKey(item.wrappedKey, userKey));

const readItemDetails = async (item: Item, userKey: VaultKey) => {
  const key = await unwrapVaultKey(item.wrappedKey, userKey);
  const properties = await decryptItemDetails(item.details, key);
  const notes = properties.notes ?? null;
  if (item.type !== 1) return { notes, login: null, properties, key };
  const credentials = properties.credentials;
  return {
    notes,
    login: {
      username: credentials?.username ?? null,
      password: credentials?.password ?? null,
      uris: (credentials?.uris ?? []).flatMap(({ uri }) =>
        uri === null ? [] : [uri],
      ),
    },
    properties,
    key,
  };
};
type ItemDetails = Awaited<ReturnType<typeof readItemDetails>>;

const openSnapshot = async (
  snapshot: Snapshot,
  key: VaultKey,
): Promise<UnlockedVault> => {
  const { items, trash, folders, ...parameters } = snapshot;
  const [entries, listedFolders] = await Promise.all([
    Promise.all(
      [
        ...items.map((item) => ({ item, trashed: false })),
        ...trash.map((item) => ({ item, trashed: true })),
      ].map(async (entry) => ({
        ...entry,
        title: await readTitle(entry.item, key).catch(() => null),
      })),
    ),
    Promise.all(
      folders.map(async (folder) => ({
        folder,
        title: await decryptVaultText(folder.name, key).catch(
          () => "Unreadable folder",
        ),
      })),
    ),
  ]);
  return {
    parameters,
    key,
    entries,
    folders: listedFolders.sort((a, b) => a.title.localeCompare(b.title)),
  };
};

const writeHeaders = {
  "content-type": "application/json",
  "x-effect-auth-csrf": "1",
};

const downloadVaultFile = (blob: Blob, name: string) => {
  const link = create("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

class VaultReader extends HTMLElement {
  #vault: UnlockedVault | null = null;
  #pending: AbortController | null = null;
  #workspace: VaultWorkspace | null = null;
  #view: VaultView = "active";
  #folderId: string | undefined;
  #selectedId: string | undefined;
  #busy = false;

  connectedCallback() {
    window.addEventListener("pagehide", this.#onPageHide);
    this.#showUnlock();
  }

  disconnectedCallback() {
    window.removeEventListener("pagehide", this.#onPageHide);
    this.#clear();
  }

  #onPageHide = () => {
    this.#clear();
    this.#showUnlock();
  };

  #stopWork() {
    this.#pending?.abort();
    this.#pending = null;
    this.#setBusy(false);
  }

  #clear() {
    this.#stopWork();
    this.#vault = null;
    this.#workspace = null;
    this.#view = "active";
    this.#folderId = undefined;
    this.#selectedId = undefined;
    this.querySelectorAll("form").forEach((form) => form.reset());
    this.replaceChildren();
  }

  #lock = () => {
    this.#clear();
    this.#showUnlock();
    this.querySelector("input")?.focus();
  };

  async #run<T>(
    work: (signal: AbortSignal) => Promise<T>,
    complete: (result: T) => void,
    failed: () => void,
    { blockNavigation = false } = {},
  ) {
    this.#stopWork();
    const controller = new AbortController();
    this.#pending = controller;
    if (blockNavigation) this.#setBusy(true);
    try {
      const result = await work(controller.signal);
      if (!controller.signal.aborted && this.isConnected) {
        if (blockNavigation) this.#setBusy(false);
        complete(result);
      }
    } catch {
      if (!controller.signal.aborted && this.isConnected) {
        if (blockNavigation) this.#setBusy(false);
        failed();
      }
    } finally {
      if (this.#pending === controller) this.#pending = null;
    }
  }

  #setBusy(busy: boolean) {
    this.#busy = busy;
    this.#updateNavigation();
  }

  #updateNavigation() {
    const workspace = this.#workspace;
    if (!workspace) return;
    const { tools, filters, listPane, detail } = workspace;
    tools.inert =
      filters.inert =
      listPane.inert =
        this.#busy || detail.classList.contains("vault-editor");
    detail.inert = this.#busy;
  }

  #showUnlock(error?: string) {
    const form = passwordForm("Unlock vault", (password) => {
      const status = create("p", "Unlocking vault…");
      status.setAttribute("role", "status");
      this.replaceChildren(status, action("Cancel", this.#lock));
      let failure = "Could not load your vault. Try again.";
      void this.#run(
        async (signal) => {
          const response = await fetch(vaultItemsPath, {
            cache: "no-store",
            signal,
          });
          if (response.status === 401)
            failure = "Sign in to OneApp to open your vault.";
          if (!response.ok) throw new Error("Vault fetch failed");
          const snapshot = decodeSnapshot(await response.json());
          failure = "Could not unlock the vault. Check your master password.";
          const key = await unlockVault(password, snapshot);
          signal.throwIfAborted();
          return openSnapshot(snapshot, key);
        },
        (vault) => {
          this.#vault = vault;
          this.#mountWorkspace();
          this.#showItems("active");
        },
        () => this.#showUnlock(failure),
      );
    });
    this.replaceChildren(form, ...(error ? [alert(error)] : []));
  }

  #toolbar(back?: () => void, ...actions: (HTMLElement | undefined)[]) {
    const toolbar = create("div");
    toolbar.className = "vault-toolbar";
    if (back)
      toolbar.append(
        action("Back", () => {
          this.#stopWork();
          back();
        }),
      );
    for (const button of actions) if (button) toolbar.append(button);
    return toolbar;
  }

  #showBrowse = (message?: string) => this.#showItems(this.#view, message);
  #showTrash = (message?: string) => this.#showItems("trash", message);

  #viewFor(entry: ListedItem): VaultView {
    return entry.trashed
      ? "trash"
      : entry.item.archivedAt !== null
        ? "archive"
        : "active";
  }

  #folderOptions(all: boolean) {
    const select = create("select");
    if (all) select.add(new Option("All folders", "*"));
    select.add(new Option("No folder", ""));
    for (const { folder, title } of this.#vault?.folders ?? [])
      select.add(new Option(title, folder.id));
    return select;
  }

  #mountWorkspace() {
    const root = create("div");
    root.className = "vault-workspace";
    const header = create("header");
    header.className = "vault-workspace-header";
    const tools = menu(
      "Vault tools",
      ...(
        [
          ["Manage folders", () => this.#showFolders()],
          ["Import", () => this.#showImport()],
          ["Export", () => this.#showExport()],
        ] as const
      ).map(([label, open]) =>
        action(label, () => {
          this.#stopWork();
          this.#selectItem();
          open();
        }),
      ),
    );
    header.append(
      create("h1", "Password vault"),
      tools,
      action("Lock vault", this.#lock),
    );

    const filters = create("nav");
    filters.className = "vault-filters";
    filters.setAttribute("aria-label", "Vault filters");
    const viewButtons = create("div");
    viewButtons.className = "vault-views";
    const views = (Object.keys(vaultViews) as VaultView[]).map((view) => {
      const button = action(vaultViews[view], () => {
        button.focus({ preventScroll: true });
        this.#showItems(view);
      });
      button.value = view;
      viewButtons.append(button);
      return button;
    });
    const type = create("select");
    type.add(new Option("All types", ""));
    for (const kind of allItemTypes)
      type.add(new Option(itemTypes[kind].label, String(kind)));
    const folder = create("select");
    const typeFilter = create("label", "Item type");
    typeFilter.append(type);
    const folderFilter = create("label", "Folder");
    folderFilter.append(folder);
    filters.append(viewButtons, typeFilter, folderFilter);

    const listPane = create("section");
    listPane.className = "vault-list-pane";
    listPane.setAttribute("aria-label", "Vault items");
    const listHeader = create("div");
    listHeader.className = "vault-list-header";
    const search = create("input");
    search.type = "search";
    search.placeholder = "Search items";
    search.setAttribute("aria-label", "Search items by title");
    search.autocomplete = "off";
    search.spellcheck = false;
    const newItem = action("New item", () => {
      this.#selectItem();
      this.#showItemTypes();
    });
    newItem.className = "vault-primary";
    listHeader.append(search, newItem);
    const status = create("div");
    const bulk = create("div");
    bulk.className = "vault-bulk";
    bulk.hidden = true;
    const results = create("div");
    results.className = "vault-results";
    listPane.append(listHeader, status, bulk, results);

    const detail = create("section");
    detail.className = "vault-detail";
    detail.tabIndex = -1;
    detail.setAttribute("aria-label", "Item details");
    root.append(header, filters, listPane, detail);
    this.#workspace = {
      root,
      tools,
      filters,
      views,
      type,
      folder,
      listPane,
      search,
      newItem,
      status,
      bulk,
      results,
      detail,
    };
    search.addEventListener("input", () => this.#renderResults(true));
    type.addEventListener("change", () => this.#renderResults(true));
    folder.addEventListener("change", () => {
      this.#folderId = folder.value === "*" ? undefined : folder.value;
      this.#renderResults(true);
    });
    this.replaceChildren(root);
  }

  #showPanel(nodes: HTMLElement[], editing = false) {
    const workspace = this.#workspace;
    if (!workspace) return;
    workspace.root.dataset.panel = "";
    workspace.detail.classList.toggle("vault-editor", editing);
    workspace.detail.replaceChildren(...nodes);
    workspace.detail.scrollTop = 0;
    this.#updateNavigation();
    if (document.activeElement !== workspace.search)
      workspace.detail.focus({ preventScroll: true });
  }

  #selectItem(id?: string) {
    this.#selectedId = id;
    this.#workspace?.results
      .querySelectorAll<HTMLButtonElement>(".vault-row")
      .forEach((row) => {
        if (row.value === id) row.setAttribute("aria-current", "true");
        else row.removeAttribute("aria-current");
      });
  }

  #updateFilters() {
    const workspace = this.#workspace;
    if (!workspace) return;
    const { folder, type, views, newItem } = workspace;
    for (const button of views) {
      if (button.value === this.#view)
        button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
    folder.replaceChildren(...this.#folderOptions(true).options);
    const active = this.#view === "active";
    if (
      !Array.from(folder.options).some(({ value }) => value === this.#folderId)
    )
      this.#folderId = undefined;
    folder.value = this.#folderId ?? "*";
    folder.disabled = !active;
    type.disabled = !active;
    newItem.hidden = !active;
  }

  #showItems(view: VaultView, message?: string, problem?: string) {
    this.#stopWork();
    const workspace = this.#workspace;
    if (!workspace) return;
    const { root, detail, search, status, results } = workspace;
    const resetScroll = view !== this.#view;
    const previousId = this.#selectedId;
    const changed =
      resetScroll ||
      message !== undefined ||
      problem !== undefined ||
      !results.childElementCount;
    this.#view = view;
    this.#selectItem();
    delete root.dataset.panel;
    detail.classList.remove("vault-editor");
    detail.replaceChildren(create("p", "Select an item to view its details."));
    this.#updateNavigation();
    if (changed) {
      this.#updateFilters();
      this.#renderResults(resetScroll);
    }
    status.replaceChildren(
      ...(message ? [statusMessage(message)] : []),
      ...(problem
        ? [
            alert(problem),
            action("Reload vault", () =>
              this.#refresh(() => this.#showItems(view, "Vault reloaded.")),
            ),
          ]
        : []),
    );
    const previous = Array.from(
      results.querySelectorAll<HTMLButtonElement>(".vault-row"),
    ).find(({ value }) => value === previousId);
    if (!workspace.filters.contains(document.activeElement))
      (previous ?? search).focus({ preventScroll: true });
  }

  #renderResults(resetScroll = false) {
    const vault = this.#vault;
    const workspace = this.#workspace;
    if (!vault || !workspace) return;
    const { search, type, results, bulk } = workspace;
    const view = this.#view;
    const query = search.value.trim().toLowerCase();
    const scroll = resetScroll ? 0 : results.scrollTop;
    const list = create("ul");
    list.className = "vault-items";
    const entries = vault.entries
      .filter((entry) => this.#viewFor(entry) === view)
      .filter(
        ({ item, title }) =>
          (!query || (title ?? "").toLowerCase().includes(query)) &&
          (view !== "active" ||
            ((!type.value || String(item.type) === type.value) &&
              (this.#folderId === undefined ||
                (item.folderId ?? "") === this.#folderId))),
      )
      .sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
    const selected = new Set<ListedItem>();
    bulk.replaceChildren();
    bulk.hidden = true;
    const count = create("span");
    count.setAttribute("role", "status");
    bulk.append(count);
    const operation = (label: string, kind: BulkAction) =>
      action(label, () => this.#startBulk(view, [...selected], kind));
    if (view === "trash")
      bulk.append(
        operation("Restore selected", "restore"),
        operation("Permanently delete selected", "purge"),
      );
    else
      bulk.append(
        operation("Move selected to folder", "move"),
        view === "active"
          ? operation("Archive selected", "archive")
          : operation("Unarchive selected", "unarchive"),
        operation("Move selected to Trash", "trash"),
      );
    for (const entry of entries) {
      const row = create("li");
      const select = create("input");
      select.type = "checkbox";
      select.setAttribute(
        "aria-label",
        `Select ${entry.title ?? "unreadable item"}`,
      );
      select.addEventListener("change", () => {
        if (select.checked) selected.add(entry);
        else selected.delete(entry);
        count.textContent = `${selected.size} selected`;
        bulk.hidden = selected.size === 0;
      });
      const open = action("", () => this.#open(entry));
      open.className = "vault-row";
      open.value = entry.item.id;
      open.append(
        create("span", entry.title ?? "Unreadable item"),
        create("small", itemTypes[entry.item.type].label),
      );
      row.append(open, select);
      list.append(row);
    }
    const filtered =
      view === "active" && (type.value || this.#folderId !== undefined);
    const empty = create(
      "p",
      query || filtered ? "No matching items." : "No items in this view.",
    );
    empty.className = "vault-empty";
    empty.setAttribute("role", "status");
    results.replaceChildren(list.childElementCount ? list : empty);
    results.scrollTop = scroll;
    this.#selectItem(this.#selectedId);
  }

  async #reload(vault: UnlockedVault, signal: AbortSignal) {
    const response = await fetch(vaultItemsPath, { cache: "no-store", signal });
    if (!response.ok) throw new Error("Vault reload failed");
    const snapshot = decodeSnapshot(await response.json());
    if (snapshot.keyId !== vault.parameters.keyId)
      throw new Error("Vault key changed");
    return openSnapshot(snapshot, vault.key);
  }

  #refresh(done: () => void) {
    const vault = this.#vault;
    if (!vault) return;
    void this.#run(
      (signal) => this.#reload(vault, signal),
      (current) => {
        this.#vault = current;
        done();
      },
      () =>
        this.#workspace?.status.append(
          alert("Could not reload your vault. Lock and unlock to try again."),
        ),
      { blockNavigation: true },
    );
  }

  #startBulk(view: VaultView, entries: ListedItem[], kind: BulkAction) {
    this.#stopWork();
    const folder = this.#folderOptions(false);
    const execute = () =>
      this.#applyBulk(view, entries, kind, folder.value || null);
    if (kind === "move") {
      if (entries.length === 1) folder.value = entries[0]!.item.folderId ?? "";
      this.#showPanel([
        this.#toolbar(() => this.#showItems(view)),
        create("h2", "Move to folder"),
        folder,
        action("Move items", execute),
      ]);
      folder.setAttribute("aria-label", "Destination folder");
      folder.focus();
    } else if (kind === "purge") {
      this.#showPanel([
        this.#toolbar(() => this.#showItems(view)),
        create("h2", "Permanently delete items?"),
        create(
          "p",
          `Delete ${entries.length} selected item(s) permanently. This cannot be undone.`,
        ),
        action("Permanently delete", execute),
        action("Cancel", () => this.#showItems(view)),
      ]);
    } else execute();
  }

  #applyBulk(
    view: VaultView,
    entries: ListedItem[],
    kind: BulkAction,
    folderId: string | null,
  ) {
    const vault = this.#vault;
    if (!vault) return;
    let problem = "Could not update the selected items. Try again.";
    this.#showPanel([statusMessage("Updating items…")]);
    void this.#run(
      async (signal) => {
        const response = await fetch(vaultBulkPath, {
          method: "PUT",
          headers: writeHeaders,
          signal,
          body: JSON.stringify({
            keyId: vault.parameters.keyId,
            kind,
            items: entries.map(({ item }) => ({
              id: item.id,
              revision: item.revision,
            })),
            ...(kind === "move" ? { folderId } : {}),
          }),
        });
        if (response.status === 404 || response.status === 409)
          problem =
            "An item or folder changed. Reload your vault and select the items again.";
        if (!response.ok) throw new Error("Vault selection update failed");
        return this.#reload(vault, signal);
      },
      (current) => {
        this.#vault = current;
        this.#showItems(
          view,
          kind === "purge" ? "Items permanently deleted." : "Items updated.",
        );
      },
      () => this.#showItems(view, undefined, problem),
      { blockNavigation: true },
    );
  }

  #showImport() {
    const vault = this.#vault;
    if (!vault) return;
    const form = create("form");
    form.method = "post";
    const file = create("input");
    file.type = "file";
    file.accept = ".csv,.json,text/csv,application/json";
    file.required = true;
    const password = create("input");
    password.type = "password";
    password.maxLength = vaultPasswordMaximum;
    password.autocomplete = "off";
    const review = create("button", "Review import");
    review.type = "submit";
    const error = alert("");
    error.hidden = true;
    form.append(
      itemField(["Bitwarden export file", file]),
      itemField(["File password, if protected", password]),
      review,
      error,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const selected = file.files?.[0];
      if (!selected || review.disabled) return;
      const secret = password.value;
      password.value = "";
      error.hidden = true;
      review.disabled = true;
      let problem = "Could not prepare your import.";
      void this.#run(
        async (signal) => {
          if (selected.size > vaultImportBytes) {
            problem = "Choose a file up to 1 MiB.";
            throw new Error("Import file too large");
          }
          let parsed: Awaited<ReturnType<typeof readPortableVault>>;
          try {
            parsed = await readPortableVault(
              await selected.text(),
              secret,
              signal,
            );
          } catch (error) {
            if (error instanceof Error) problem = error.message;
            throw error;
          }
          const encrypted = await sealPortableVault(parsed, vault.key, signal);
          const body = JSON.stringify({
            keyId: vault.parameters.keyId,
            ...encrypted,
          });
          if (body.length > vaultImportBytes) {
            problem =
              "The encrypted import exceeds 1 MiB. Split it into smaller files.";
            throw new Error("Import body too large");
          }
          return {
            body,
            items: parsed.items.length,
            folders: parsed.folders.length,
          };
        },
        (prepared) => {
          form.reset();
          this.#confirmImport(prepared);
        },
        () => {
          review.disabled = false;
          error.textContent = problem;
          error.hidden = false;
        },
      );
    });
    this.#showPanel([
      this.#toolbar(this.#showBrowse),
      create("h2", "Import into your vault"),
      form,
    ]);
    file.focus();
  }

  #confirmImport(prepared: { body: string; items: number; folders: number }) {
    const vault = this.#vault;
    if (!vault) return;
    const error = alert("");
    error.hidden = true;
    const submit = action("Import items", () => {
      submit.disabled = true;
      error.hidden = true;
      let failure = "Could not confirm the import. Try again.";
      void this.#run(
        async (signal) => {
          const response = await fetch(vaultImportPath, {
            method: "POST",
            headers: writeHeaders,
            body: prepared.body,
            signal,
          });
          if (response.status === 400 || response.status === 409) {
            const data = (await response.json()) as { error?: string };
            failure = data.error ?? failure;
          }
          if (!response.ok) throw new Error("Import failed");
          return this.#reload(vault, signal);
        },
        (current) => {
          this.#vault = current;
          this.#showBrowse(
            `Imported ${prepared.items} item(s) and ${prepared.folders} folder(s).`,
          );
        },
        () => {
          submit.disabled = false;
          error.textContent = failure;
          error.hidden = false;
        },
        { blockNavigation: true },
      );
    });
    this.#showPanel([
      this.#toolbar(() => this.#showImport()),
      create("h2", "Review import"),
      create(
        "p",
        `Import ${prepared.items} item(s) and ${prepared.folders} folder(s). Importing the same file again creates copies.`,
      ),
      submit,
      error,
    ]);
    submit.focus();
  }

  #showExport() {
    const vault = this.#vault;
    if (!vault) return;
    const form = create("form");
    form.method = "post";
    const format = create("select");
    format.add(new Option("Bitwarden JSON", "json"));
    format.add(new Option("Bitwarden CSV", "csv"));
    format.add(new Option("Bitwarden ZIP with attachments", "zip"));
    format.add(new Option("Password-protected Bitwarden JSON", "protected"));
    const formatLabel = create("label", "File format");
    formatLabel.className = "vault-item-field";
    formatLabel.append(format);
    const master = create("input");
    master.type = "password";
    master.autocomplete = "off";
    master.required = true;
    master.maxLength = vaultPasswordMaximum;
    const secret = master.cloneNode() as HTMLInputElement;
    const repeat = master.cloneNode() as HTMLInputElement;
    const encryption = create("fieldset");
    const warning = create("p");
    encryption.append(
      itemField(["Export password", secret]),
      itemField(["Confirm export password", repeat]),
    );
    const changeFormat = () => {
      const protectedFile = format.value === "protected";
      encryption.hidden = !protectedFile;
      encryption.disabled = !protectedFile;
      secret.value = repeat.value = "";
      warning.textContent = protectedFile
        ? "Keep the export password. You’ll need it to import the file."
        : format.value === "csv"
          ? "Download plaintext logins and Secure Notes. CSV omits passkeys."
          : format.value === "zip"
            ? "Download a plaintext copy of your vault and attachments."
            : "Download a plaintext copy of your vault items and folders.";
    };
    format.addEventListener("change", changeFormat);
    changeFormat();
    const submit = create("button", "Download export");
    submit.type = "submit";
    const error = alert("");
    error.hidden = true;
    form.append(
      formatLabel,
      warning,
      encryption,
      itemField(["Vault master password", master]),
      submit,
      error,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      if (format.value === "protected" && secret.value !== repeat.value) {
        error.textContent = "The export passwords must match.";
        error.hidden = false;
        return;
      }
      submit.disabled = true;
      error.hidden = true;
      const password = master.value;
      const exportPassword = secret.value;
      master.value = secret.value = repeat.value = "";
      const chosen = format.value;
      let problem = "Could not load your vault.";
      void this.#run(
        async (signal) => {
          const result = await fetch(vaultItemsPath, {
            cache: "no-store",
            signal,
          });
          if (!result.ok) throw new Error("Vault snapshot unavailable");
          const snapshot = decodeSnapshot(await result.json());
          problem = "Check your master password and try again.";
          const key = await unlockVault(password, snapshot);
          signal.throwIfAborted();
          problem = "Could not read all items for export.";
          const portable = await openPortableVault(
            snapshot,
            key,
            signal,
            chosen !== "csv",
          );
          if (chosen === "zip")
            return {
              format: "zip" as const,
              ...(await writeVaultZip(portable, snapshot, key, signal)),
            };
          const data =
            chosen === "csv"
              ? writePortableCsv(portable)
              : chosen === "protected"
                ? await writeProtectedExport(portable, exportPassword)
                : writePortableJson(portable);
          return { format: "text" as const, data };
        },
        (result) => {
          if (result.format === "zip") {
            downloadVaultFile(result.archive, "oneapp-vault.zip");
            if (result.failed.length) {
              const missing = create("ul");
              for (const name of result.failed)
                missing.append(create("li", name));
              this.#showPanel([
                this.#toolbar(this.#showBrowse),
                alert(
                  `The ZIP contains ${result.count} attachment(s). ${result.failed.length} could not be included.`,
                ),
                missing,
              ]);
              return;
            }
          } else {
            downloadVaultFile(
              new Blob([result.data], {
                type: chosen === "csv" ? "text/csv" : "application/json",
              }),
              chosen === "csv" ? "oneapp-vault.csv" : "oneapp-vault.json",
            );
          }
          this.#showBrowse("Vault export downloaded.");
        },
        () => {
          submit.disabled = false;
          error.textContent = problem;
          error.hidden = false;
          master.focus();
        },
      );
    });
    this.#showPanel([
      this.#toolbar(this.#showBrowse),
      create("h2", "Export your vault"),
      form,
    ]);
    format.focus();
  }

  #showAttachments(entry: ListedItem, key: VaultKey, message?: string) {
    this.#stopWork();
    const vault = this.#vault;
    if (!vault) return;
    const item = entry.item;
    const back = () => this.#open(entry);
    const heading = create("h2", `Attachments for ${entry.title ?? "item"}`);
    const status = alert("");
    status.hidden = true;
    const showError = (problem: string) => {
      status.textContent = problem;
      status.hidden = false;
    };
    const list = create("ul");
    const display = (attachment: AttachmentMetadata, name: string | null) => {
      const row = create("li");
      row.append(create("span", name ?? "Unreadable attachment"));
      if (name !== null) {
        const download = action("Download plaintext", () => {
          status.hidden = true;
          download.disabled = true;
          void this.#run(
            (signal) => openVaultAttachment(item.id, attachment, key, signal),
            (bytes) => {
              const file = new Blob([bytes], {
                type: "application/octet-stream",
              });
              bytes.fill(0);
              downloadVaultFile(file, name);
              download.disabled = false;
            },
            () => {
              download.disabled = false;
              showError("Could not read this attachment.");
            },
          );
        });
        row.append(download);
      }
      if (!entry.trashed)
        row.append(
          action("Remove", () => {
            this.#replaceAttachment(
              entry,
              key,
              "Attachment removed.",
              (signal) => removeVaultAttachment(item.id, attachment.id, signal),
              showError,
            );
          }),
        );
      list.append(row);
    };
    if (item.attachments.length) {
      void this.#run(
        async () =>
          Promise.all(
            item.attachments.map(async (attachment) => ({
              attachment,
              name: await decryptVaultText(attachment.name, key).catch(
                () => null,
              ),
            })),
          ),
        (records) => {
          for (const { attachment, name } of records) display(attachment, name);
        },
        () => showError("Could not list attachments."),
      );
    }
    const form = create("form");
    form.method = "post";
    const input = create("input");
    input.type = "file";
    input.required = true;
    const upload = create("button", "Upload attachment");
    upload.type = "submit";
    let sealed: Awaited<ReturnType<typeof encryptVaultAttachment>> | undefined;
    input.addEventListener("change", () => {
      sealed = undefined;
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const file = input.files?.[0];
      if (!file || upload.disabled) return;
      upload.disabled = input.disabled = true;
      status.hidden = true;
      this.#replaceAttachment(
        entry,
        key,
        "Attachment uploaded.",
        async (signal) => {
          sealed ??= await encryptVaultAttachment(file, key);
          signal.throwIfAborted();
          await uploadVaultAttachment(
            item.id,
            item.revision,
            vault.parameters.keyId,
            sealed,
            signal,
          );
        },
        (error) => {
          upload.disabled = input.disabled = false;
          showError(error);
        },
      );
    });
    form.append(itemField(["Choose attachment", input]), upload);
    this.#showPanel([
      this.#toolbar(back),
      heading,
      ...(message ? [statusMessage(message)] : []),
      status,
      item.attachments.length ? list : create("p", "No attachments."),
      ...(entry.trashed ? [] : [form]),
    ]);
  }

  #replaceAttachment(
    entry: ListedItem,
    key: VaultKey,
    message: string,
    mutate: (signal: AbortSignal) => Promise<void>,
    failed: (message: string) => void,
  ) {
    const vault = this.#vault;
    if (!vault) return;
    let problem = "Could not update this attachment.";
    void this.#run(
      async (signal) => {
        try {
          await mutate(signal);
        } catch (error) {
          if (error instanceof Error) problem = error.message;
          throw error;
        }
        return this.#reload(vault, signal);
      },
      (current) => {
        this.#vault = current;
        const latest = current.entries.find(
          ({ item }) => item.id === entry.item.id,
        );
        if (latest && latest.item.wrappedKey === entry.item.wrappedKey) {
          this.#updateFilters();
          this.#renderResults();
          this.#showAttachments(latest, key, message);
        } else this.#showBrowse(message);
      },
      () => failed(problem),
      { blockNavigation: true },
    );
  }

  #showFolders(message?: string) {
    this.#stopWork();
    const list = create("ul");
    for (const entry of this.#vault?.folders ?? []) {
      const row = create("li");
      row.append(
        create("span", entry.title),
        action("Rename", () => this.#folderForm(entry)),
        action("Delete folder", () => this.#folderForm(entry, true)),
      );
      list.append(row);
    }
    this.#showPanel([
      this.#toolbar(
        this.#showBrowse,
        action("New folder", () => this.#folderForm()),
      ),
      create("h2", "Folders"),
      ...(message ? [statusMessage(message)] : []),
      list,
    ]);
  }

  #folderForm(entry?: ListedFolder, deleting = false) {
    const vault = this.#vault;
    if (!vault) return;
    const verb = deleting
      ? "Delete folder"
      : entry
        ? "Rename folder"
        : "New folder";
    const form = create("form");
    form.method = "post";
    const input = create("input");
    input.required = !deleting;
    input.value = entry?.title ?? "";
    const save = create("button", deleting ? "Delete folder" : "Save folder");
    save.type = "submit";
    const status = alert("");
    status.hidden = true;
    const back = () => this.#showFolders();
    let sealed: string | undefined;
    form.addEventListener("input", () => {
      sealed = undefined;
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (save.disabled || (!deleting && !input.value.trim())) return;
      save.disabled = true;
      input.readOnly = true;
      status.hidden = true;
      let failure = "Could not save the folder. Try again.";
      void this.#run(
        async (signal) => {
          sealed ??= JSON.stringify({
            keyId: vault.parameters.keyId,
            ...(entry ? { expectedRevision: entry.folder.revision } : {}),
            ...(!deleting
              ? { name: await encryptVaultText(input.value.trim(), vault.key) }
              : {}),
          });
          const response = await fetch(
            entry ? vaultFolderPath(entry.folder.id) : vaultFoldersPath,
            {
              method: deleting ? "DELETE" : entry ? "PUT" : "POST",
              headers: writeHeaders,
              body: sealed,
              signal,
            },
          );
          if (response.status === 409 || response.status === 404)
            failure = "This folder changed. Reload your vault.";
          if (!response.ok) throw new Error("Folder request failed");
          return this.#reload(vault, signal);
        },
        (current) => {
          this.#vault = current;
          this.#updateFilters();
          this.#renderResults();
          this.#showFolders(
            deleting
              ? "Folder deleted. Its items are still in your vault."
              : "Folder saved.",
          );
        },
        () => {
          save.disabled = false;
          input.readOnly = false;
          status.hidden = false;
          status.textContent = failure;
        },
        { blockNavigation: true },
      );
    });
    form.append(
      deleting
        ? create("p", `Items in ${entry?.title} will move to No folder.`)
        : itemField(["Folder name", input]),
      save,
      status,
    );
    this.#showPanel([this.#toolbar(back), create("h2", verb), form]);
    (deleting ? save : input).focus();
  }

  #rememberItem(vault: UnlockedVault, entry: ListedItem) {
    vault.entries = vault.entries.filter(
      ({ item }) => item.id !== entry.item.id,
    );
    vault.entries.push(entry);
  }

  #changeLifecycle(entry: ListedItem, details: ItemDetails | null) {
    const vault = this.#vault;
    if (!vault) return;
    const restoring = entry.trashed;
    this.#showPanel([
      this.#toolbar(),
      statusMessage(restoring ? "Restoring item…" : "Moving item to Trash…"),
    ]);
    let failure = restoring
      ? "Could not restore this item. Try again."
      : "Could not move this item to Trash. Try again.";
    void this.#run(
      async (signal) => {
        const response = await fetch(
          vaultLifecyclePath(entry.item.id, restoring ? "restore" : "trash"),
          {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              "x-effect-auth-csrf": "1",
            },
            body: JSON.stringify({
              keyId: vault.parameters.keyId,
              expectedRevision: entry.item.revision,
            }),
            signal,
          },
        );
        if (response.status === 401)
          failure = "Sign in to OneApp to update this item.";
        if (response.status === 409 || response.status === 404)
          failure =
            "This item changed. Lock and unlock your vault to reload it.";
        if (!response.ok) throw new Error("Vault item lifecycle change failed");
        const item = decodeItem(await response.json());
        // The request may already have succeeded in another client.
        const title =
          item.name === entry.item.name &&
          item.wrappedKey === entry.item.wrappedKey
            ? entry.title
            : await readTitle(item, vault.key).catch(() => null);
        return { item, title, trashed: !restoring };
      },
      (saved) => {
        this.#rememberItem(vault, saved);
        this.#showItems(
          this.#viewFor(entry),
          restoring ? "Restored to your vault." : "Moved to Trash.",
        );
      },
      () => this.#showDetails(entry, details, failure),
      { blockNavigation: true },
    );
  }

  #showNoteForm(edit?: NoteEdit) {
    const note = create("textarea");
    note.rows = 6;
    note.value = edit?.notes ?? "";
    this.#showItemForm(
      "Secure Note",
      [["Note", note]],
      async (title, key) =>
        edit
          ? {
              expectedRevision: edit.item.revision,
              ...(await encryptNoteFields(
                title,
                note.value,
                await unwrapVaultKey(edit.item.wrappedKey, key, "encrypt"),
              )),
            }
          : encryptSecureNote(title, note.value, key),
      edit,
    );
  }

  #showLoginForm(edit?: LoginEdit) {
    const username = create("input");
    username.value = edit?.login.username ?? "";
    const password = create("input");
    password.type = "password";
    password.autocomplete = "new-password";
    password.value = edit?.login.password ?? "";
    const website = create("input");
    website.inputMode = "url";
    website.placeholder = "https://example.com";
    website.value = edit?.login.uris[0] ?? "";
    const previousWebsite = website.value;
    const normalizedWebsite = () => {
      const address = website.value.trim();
      if (!address) return "";
      if (!/^https?:\/\//iu.test(address)) return null;
      return URL.parse(address)?.href ?? null;
    };
    website.addEventListener("input", () =>
      website.setCustomValidity(
        website.value === previousWebsite || normalizedWebsite() !== null
          ? ""
          : "Enter an HTTP or HTTPS website address.",
      ),
    );
    this.#showItemForm(
      "Login",
      [
        ["Username", username],
        ["Password", password],
        [
          (edit?.login.uris.length ?? 0) > 1 ? "Primary website" : "Website",
          website,
        ],
      ],
      async (title, key) => {
        const websiteChanged = website.value !== previousWebsite;
        const address = websiteChanged ? normalizedWebsite() : "";
        if (address === null) throw new Error("Invalid website address");
        if (!edit)
          return encryptLogin(
            {
              title,
              username: username.value,
              password: password.value,
              website: address,
            },
            key,
          );
        const itemKey = await unwrapVaultKey(
          edit.item.wrappedKey,
          key,
          "encrypt",
        );
        return {
          type: 1,
          expectedRevision: edit.item.revision,
          name:
            title === edit.title
              ? edit.item.name
              : await encryptVaultText(title, itemKey),
          username:
            username.value === (edit.login.username ?? "")
              ? edit.item.username
              : await encryptOptionalText(username.value, itemKey),
          password:
            password.value === (edit.login.password ?? "")
              ? edit.item.password
              : await encryptOptionalText(password.value, itemKey),
          website: websiteChanged
            ? {
                previousUri: edit.item.uris[0] ?? null,
                replacement:
                  address === ""
                    ? null
                    : await encryptWebsite(address, itemKey),
              }
            : undefined,
        };
      },
      edit,
    );
  }

  #showItemTypes() {
    this.#stopWork();
    const choices = create("ul");
    choices.className = "vault-item-types";
    for (const type of allItemTypes) {
      const row = create("li");
      row.append(
        action(itemTypes[type].label, () => {
          if (type === 1) this.#showLoginForm();
          else if (type === 2) this.#showNoteForm();
          else this.#showDetailedForm(type);
        }),
      );
      choices.append(row);
    }
    this.#showPanel([
      this.#toolbar(this.#showBrowse),
      create("h2", "New item"),
      choices,
    ]);
  }

  #showDetailedForm(
    type: ItemType,
    edit?: EditTarget & { details: ItemDetails },
  ) {
    const editor = vaultItemEditor(type, edit?.details.properties ?? {});
    this.#showItemForm(
      itemTypes[type].label,
      [],
      async (title, key) => {
        const encrypt = async (itemKey: VaultKey) => ({
          type,
          name:
            title === edit?.title
              ? edit.item.name
              : await encryptVaultText(title, itemKey),
          details: await editor.encrypt(itemKey, edit?.item.details),
        });
        return edit
          ? {
              expectedRevision: edit.item.revision,
              ...(await encrypt(
                await unwrapVaultKey(edit.item.wrappedKey, key, "encrypt"),
              )),
            }
          : encryptNewItem(key, encrypt);
      },
      edit,
      editor.element,
    );
  }

  #showItemForm(
    label: string,
    fields: readonly ItemField[],
    encrypt: (title: string, key: VaultKey) => Promise<object>,
    edit?: EditTarget,
    properties?: HTMLElement,
  ) {
    const vault = this.#vault;
    if (!vault) return;
    this.#stopWork();
    const form = create("form");
    form.method = "post";
    form.autocomplete = "off";
    const title = create("input");
    title.required = true;
    title.value = edit?.title ?? "";
    const inputs: readonly ItemField[] = [["Title", title], ...fields];
    const item =
      label === "Login" ? "login" : label === "Secure Note" ? "note" : "item";
    const saveLabel = `Save ${label}`;
    const save = create("button", saveLabel);
    save.type = "submit";
    const error = alert("");
    error.hidden = true;
    const setBusy = (status?: string) => {
      save.disabled = status !== undefined;
      for (const [, input] of inputs) input.readOnly = save.disabled;
      properties
        ?.querySelectorAll<HTMLInputElement>("input, textarea, select, button")
        .forEach((input) => {
          input.disabled = save.disabled;
        });
      save.textContent = status ?? saveLabel;
      if (reload) reload.disabled = save.disabled;
    };
    const showError = (message: string) => {
      setBusy();
      error.textContent = message;
      error.hidden = false;
    };
    const reload =
      edit &&
      action("Discard draft and reload", () => {
        setBusy("Reloading…");
        error.hidden = true;
        let failure = `Could not reload this ${item}. Your draft is still here.`;
        void this.#run(
          async (signal) => {
            const response = await fetch(vaultItemsPath, {
              cache: "no-store",
              signal,
            });
            if (response.status === 401)
              failure = `Sign in to OneApp to reload this ${item}.`;
            if (!response.ok) throw new Error("Could not refresh the vault");
            const snapshot = decodeSnapshot(await response.json());
            if (snapshot.keyId !== vault.parameters.keyId) {
              failure =
                "Your vault changed. Copy your draft, then lock and unlock the vault.";
              throw new Error("Vault key changed");
            }
            const active = snapshot.items.find(({ id }) => id === edit.item.id);
            const latest =
              active ?? snapshot.trash.find(({ id }) => id === edit.item.id);
            return latest?.type === edit.item.type
              ? {
                  item: latest,
                  title: await readTitle(latest, vault.key),
                  trashed: active === undefined,
                }
              : null;
          },
          (latest) => {
            form.reset();
            if (latest) {
              this.#rememberItem(vault, latest);
              if (latest.trashed) this.#showTrash(`This ${item} is in Trash.`);
              else {
                this.#renderResults();
                this.#open(latest);
              }
            } else {
              vault.entries = vault.entries.filter(
                ({ item }) => item.id !== edit.item.id,
              );
              this.#showBrowse(`This ${item} is no longer in your vault.`);
            }
          },
          () => showError(failure),
          { blockNavigation: true },
        );
      });
    form.append(
      ...inputs.map(itemField),
      ...(properties ? [properties] : []),
      save,
      error,
    );
    if (reload) {
      reload.hidden = true;
      form.append(reload);
    }

    // Reuse the encrypted request if a save may have reached D1 before it failed.
    let sealed: string | undefined;
    form.addEventListener("input", () => {
      sealed = undefined;
      title.setCustomValidity("");
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (save.disabled) return;
      if (!title.value.trim()) {
        title.setCustomValidity("Enter a title.");
        title.reportValidity();
        return;
      }
      error.hidden = true;
      setBusy("Saving…");
      let failure = `Could not save your ${item}. Try again.`;
      void this.#run(
        async (signal) => {
          sealed ??= JSON.stringify({
            keyId: vault.parameters.keyId,
            ...(await encrypt(title.value.trim(), vault.key)),
          });
          signal.throwIfAborted();
          if (sealed.length > vaultItemBodyLimit) {
            failure = `This ${item} is too large to save.`;
            throw new Error("Encrypted item exceeds request limit");
          }
          const response = await fetch(
            edit ? vaultItemPath(edit.item.id) : vaultItemsPath,
            {
              method: edit ? "PUT" : "POST",
              headers: {
                "content-type": "application/json",
                "x-effect-auth-csrf": "1",
              },
              body: sealed,
              signal,
            },
          );
          if (response.status === 401)
            failure = `Sign in to OneApp to save your ${item}.`;
          if (reload && (response.status === 409 || response.status === 404)) {
            failure = `This ${item} changed since you opened it. Your draft is still here.`;
            if (!signal.aborted) reload.hidden = false;
          } else if (response.status === 409)
            failure =
              "Your vault changed. Lock and unlock it before saving again.";
          if (!response.ok) throw new Error("Vault item save failed");
          const saved = decodeItem(await response.json());
          return {
            item: saved,
            title: await readTitle(saved, vault.key),
            trashed: false,
          };
        },
        (entry) => {
          form.reset();
          this.#rememberItem(vault, entry);
          this.#renderResults();
          this.#open(entry);
        },
        () => showError(failure),
        { blockNavigation: true },
      );
    });
    const cancel = action("Cancel", () => {
      form.reset();
      (edit?.cancel ?? this.#showBrowse)();
    });
    this.#showPanel(
      [
        this.#toolbar(undefined, cancel),
        create("h2", `${edit ? "Edit" : "New"} ${label}`),
        form,
      ],
      true,
    );
    title.focus();
  }

  #open(entry: ListedItem, error?: string) {
    const vault = this.#vault;
    if (!vault) return;
    this.#stopWork();
    this.#selectItem(entry.item.id);
    if (entry.title === null) {
      this.#showDetails(entry, null, "Could not read this item.");
      return;
    }
    const show = (password?: string) => {
      const status = create("p", "Opening item…");
      status.setAttribute("role", "status");
      this.#showPanel([this.#toolbar(this.#showBrowse), status]);
      let failure = "Could not read this item.";
      void this.#run(
        async (signal) => {
          if (password !== undefined) {
            failure = "Check your master password and try again.";
            await unlockVault(password, vault.parameters);
            signal.throwIfAborted();
            failure = "Could not read this item.";
          }
          return readItemDetails(entry.item, vault.key);
        },
        (details) => this.#showDetails(entry, details),
        () => this.#open(entry, failure),
      );
    };
    if (entry.item.requiresMasterPassword) {
      this.#showPanel([
        this.#toolbar(this.#showBrowse),
        create("h2", entry.title),
        passwordForm("Open protected item", show),
        ...(error ? [alert(error)] : []),
      ]);
      this.#workspace?.detail.querySelector("input")?.focus();
    } else if (error) {
      this.#showDetails(entry, null, error);
    } else {
      show();
    }
  }

  #showDetails(entry: ListedItem, details: ItemDetails | null, error?: string) {
    const { item, title, trashed } = entry;
    const fields = create("dl");
    fields.className = "vault-item-fields";
    const add = (label: string, value: string) => {
      const content = create("dd", value);
      fields.append(create("dt", label), content);
      return content;
    };
    const mask = (label: string, value: string, content: HTMLElement) => {
      const rendered = create("span", "••••••••");
      const toggle = action(`Show ${label}`, () => {
        const hidden = toggle.textContent?.startsWith("Show");
        rendered.textContent = hidden ? value : "••••••••";
        toggle.textContent = `${hidden ? "Hide" : "Show"} ${label}`;
      });
      content.append(rendered, toggle);
    };
    const folder = this.#vault?.folders.find(
      ({ folder }) => folder.id === item.folderId,
    );
    if (folder) add("Folder", folder.title);
    const login = details?.login;
    if (login) {
      if (login.username !== null) add("Username", login.username);
      if (login.password !== null)
        mask("password", login.password, add("Password", ""));
      const credentials = details?.properties.credentials;
      if (item.type === 1 && item.details.credentials?.fido2Credentials?.length)
        add("Passkey", "Saved in this login");
      if (credentials?.totp)
        mask("TOTP seed", credentials.totp, add("TOTP seed", ""));
      for (const { uri, match } of credentials?.uris ?? []) {
        if (uri === null) continue;
        const website = add("Website", "");
        website.append(create("span", uri));
        if (match != null) website.append(` (${uriMatchLabels[match]})`);
      }
    }
    if (details) {
      if (details.properties.favorite) add("Favourite", "Yes");
      if (details.properties.reprompt === 1)
        add("Master password reprompt", "Required");
      for (const property of details.properties.fields ?? []) {
        const label = property.name || "Custom field";
        if (property.type === 1 && property.value != null)
          mask(label, property.value, add(label, ""));
        else if (property.type === 3)
          add(
            label,
            property.linkedId == null
              ? "Linked field"
              : linkedFieldLabel(item.type, property.linkedId),
          );
        else if (property.value != null) add(label, property.value);
      }
      for (const [name, label] of Object.entries(itemTypes[item.type].fields)) {
        const value = details.properties.data?.[name];
        if (value != null) mask(label, value, add(label, ""));
      }
      const history = item.details.passwordHistory ?? [];
      if (history.length) {
        const output = add("Password history", "");
        const show = action("Show password history", () => {
          void this.#run(
            async () =>
              Promise.all(
                history.map(async ({ password, lastUsedDate }) => ({
                  password: await readText(password ?? null, details.key),
                  lastUsedDate,
                })),
              ),
            (entries) => {
              const list = create("ul");
              for (const { password, lastUsedDate } of entries) {
                if (password === null) continue;
                const row = create(
                  "li",
                  lastUsedDate
                    ? new Date(lastUsedDate).toLocaleDateString() + " "
                    : "",
                );
                mask("previous password", password, row);
                list.append(row);
              }
              output.replaceChildren(
                action("Hide password history", () =>
                  output.replaceChildren(show),
                ),
                list,
              );
            },
            () => output.append(alert("Could not read password history.")),
          );
        });
        output.append(show);
      }
    }
    if (details?.notes != null) add("Notes", details.notes);
    const titleNode = create("h2", title ?? "Unreadable item");
    titleNode.tabIndex = -1;
    let edit: HTMLButtonElement | undefined;
    const cancel = () => this.#showDetails(entry, details);
    if (!trashed && title !== null && details) {
      if (item.type === 2)
        edit = action("Edit Secure Note", () =>
          this.#showNoteForm({ item, title, cancel, notes: details.notes }),
        );
      else if (item.type === 1 && login)
        edit = action("Edit Login", () =>
          this.#showLoginForm({ item, title, cancel, login }),
        );
      else
        edit = action(`Edit ${itemTypes[item.type].label}`, () =>
          this.#showDetailedForm(item.type, { item, title, cancel, details }),
        );
    }
    const more = menu(
      "More actions",
      details && (!trashed || item.attachments.length > 0)
        ? action("Attachments", () => {
            const vault = this.#vault;
            if (!vault) return;
            void this.#run(
              () => unwrapVaultKey(item.wrappedKey, vault.key, "both"),
              (key) => this.#showAttachments(entry, key),
              () =>
                this.#showDetails(
                  entry,
                  details,
                  "Could not open attachments.",
                ),
            );
          })
        : undefined,
      !trashed && title !== null && details && item.type <= 2
        ? action("Edit item fields", () =>
            this.#showDetailedForm(item.type, { item, title, cancel, details }),
          )
        : undefined,
      action(trashed ? "Restore" : "Move to Trash", () =>
        this.#changeLifecycle(entry, details),
      ),
      trashed
        ? action("Permanently delete", () =>
            this.#startBulk("trash", [entry], "purge"),
          )
        : action(
            item.archivedAt === null ? "Archive item" : "Unarchive item",
            () =>
              this.#startBulk(
                this.#viewFor(entry),
                [entry],
                item.archivedAt === null ? "archive" : "unarchive",
              ),
          ),
      !trashed
        ? action("Move to folder", () =>
            this.#startBulk(this.#viewFor(entry), [entry], "move"),
          )
        : undefined,
    );
    this.#showPanel([
      this.#toolbar(this.#showBrowse, edit, more),
      titleNode,
      ...(error ? [alert(error)] : []),
      ...(details
        ? [
            fields.childElementCount
              ? fields
              : create("p", "This item has no details."),
          ]
        : []),
    ]);
    if (this.#workspace?.detail === document.activeElement) titleNode.focus();
  }
}

customElements.define(vaultReader.tag, VaultReader);
