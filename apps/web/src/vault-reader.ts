import { Schema } from "effect";
import { CustomElement } from "foldkit";
import {
  decryptVaultText,
  encryptNewItem,
  encryptVaultText,
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
  vaultItemFieldset,
} from "./vault-item-editor.ts";
import { vaultField } from "./vault-field.ts";
import { vaultItemIcon } from "./vault-item-icon.ts";
import { websiteIconHostname } from "./website-icon-host.ts";
import { identityDisplayGroups } from "./vault-identity-layout.ts";
import { structuredDisplayGroup } from "./vault-item-layout.ts";
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
type ListedItem = {
  item: Item;
  title: string | null;
  trashed: boolean;
  iconHost?: string;
};
type VaultView = "active" | "archive" | "trash";
const vaultViews = { active: "All items", archive: "Archive", trash: "Trash" };
const allItemTypes = [1, 2, ...extraItemTypes] as const;
type Folder = typeof VaultFolder.Type;
type ListedFolder = { folder: Folder; title: string };
type BulkAction = (typeof VaultBulkChange.Type)["kind"];
type EditTarget = { entry: ListedItem; title: string; details: ItemDetails };
type ItemField = readonly [
  label: string,
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
];
type UnlockedVault = {
  parameters: Omit<Snapshot, "items" | "trash" | "folders">;
  key: VaultKey;
  entries: ListedItem[];
  folders: ListedFolder[];
};
type VaultWorkspace = {
  root: HTMLElement;
  filters: HTMLElement;
  views: HTMLUListElement;
  itemFilters: HTMLElement;
  types: HTMLUListElement;
  folders: HTMLUListElement;
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
const filterList = (label: string) => {
  const list = create("ul");
  list.className = "vault-filter-list";
  list.setAttribute("aria-label", label);
  return list;
};
const filterOption = (
  list: HTMLUListElement,
  label: string,
  value: string,
  select: () => void,
) => {
  const button = action(label, () => {
    button.focus({ preventScroll: true });
    select();
  });
  button.value = value;
  const option = create("li");
  option.append(button);
  list.append(option);
};
const selectFilterOption = (list: HTMLUListElement, value: string) => {
  for (const button of list.querySelectorAll("button")) {
    if (button.value === value) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
};
type DetailRow = {
  label: string;
  value: string;
  suffix?: string;
  visibility?: "visible" | "masked";
  revealLabel?: string;
  copyable?: boolean;
};
const detailFields = (rows: readonly DetailRow[]) => {
  const fields = create("dl");
  fields.className = "vault-item-fields";
  for (const {
    label,
    value,
    suffix,
    visibility,
    revealLabel,
    copyable,
  } of rows) {
    const content = create("dd");
    content.append(
      vaultField({
        label: revealLabel ?? label,
        value,
        suffix,
        masked: visibility === "masked",
        copyable,
      }).element,
    );
    fields.append(create("dt", label), content);
  }
  return fields;
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

const readLoginIconHost = async (item: Item, key: VaultKey) => {
  if (item.type !== 1 || item.requiresMasterPassword) return undefined;
  for (const { uri, match } of item.details.credentials?.uris ?? []) {
    if (uri === null || match === 4) continue;
    const website = await decryptVaultText(uri, key).catch(() => "");
    const hostname = websiteIconHostname(website);
    if (hostname) return hostname;
  }
  return undefined;
};

const readListedItem = async (
  item: Item,
  userKey: VaultKey,
  trashed = false,
): Promise<ListedItem> => {
  const key = await unwrapVaultKey(item.wrappedKey, userKey);
  const title = await decryptVaultText(item.name, key);
  const iconHost = await readLoginIconHost(item, key);
  return { item, title, trashed, iconHost };
};

const readItemDetails = async (item: Item, userKey: VaultKey) => {
  const key = await unwrapVaultKey(item.wrappedKey, userKey);
  return { properties: await decryptItemDetails(item.details, key), key };
};
type ItemDetails = Awaited<ReturnType<typeof readItemDetails>>;

const sameEditableItem = (before: Item, after: Item) =>
  before.type === after.type &&
  before.name === after.name &&
  before.wrappedKey === after.wrappedKey &&
  before.folderId === after.folderId &&
  before.archivedAt === after.archivedAt &&
  JSON.stringify(before.details) === JSON.stringify(after.details);

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
      ].map(({ item, trashed }) =>
        readListedItem(item, key, trashed).catch(() => ({
          item,
          title: null,
          trashed,
        })),
      ),
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
  #itemType: ItemType | undefined;
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
    this.#itemType = undefined;
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
    const { filters, listPane, detail } = workspace;
    filters.inert = listPane.inert =
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

  #folderOptions() {
    const select = create("select");
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
    header.append(create("h1", "Vault"), action("Lock vault", this.#lock));

    const filters = create("nav");
    filters.className = "vault-filters";
    filters.setAttribute("aria-label", "Vault navigation");
    const views = filterList("Vault views");
    views.classList.add("vault-views");
    for (const view of Object.keys(vaultViews) as VaultView[])
      filterOption(views, vaultViews[view], view, () => this.#showItems(view));

    const types = filterList("Item types");
    const addType = (label: string, kind?: ItemType) => {
      const value = String(kind ?? "");
      filterOption(types, label, value, () => {
        if (this.#itemType === kind) return;
        this.#itemType = kind;
        selectFilterOption(types, value);
        this.#renderResults(true);
      });
    };
    addType("All types");
    for (const kind of allItemTypes) addType(itemTypes[kind].label, kind);
    const folders = filterList("Folders");
    const typeFilter = create("div");
    typeFilter.append(create("h2", "Item types"), types);
    const folderFilter = create("div");
    folderFilter.append(create("h2", "Folders"), folders);
    const itemFilters = create("div");
    itemFilters.className = "vault-item-filters";
    itemFilters.append(typeFilter, folderFilter);
    const tools = filterList("Vault tools");
    tools.classList.add("vault-nav-tools");
    for (const [label, open] of [
      ["Import", () => this.#showImport()],
      ["Export", () => this.#showExport()],
      ["Manage folders", () => this.#showFolders()],
    ] as const) {
      const row = create("li");
      row.append(
        action(label, () => {
          this.#stopWork();
          this.#selectItem();
          open();
        }),
      );
      tools.append(row);
    }
    filters.append(views, itemFilters, tools);

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
    status.className = "vault-list-status";
    const bulk = create("footer");
    bulk.className = "vault-bulk";
    bulk.setAttribute("role", "group");
    bulk.setAttribute("aria-label", "Selected item actions");
    bulk.hidden = true;
    const results = create("div");
    results.className = "vault-results";
    listPane.append(listHeader, status, results, bulk);

    const detail = create("section");
    detail.className = "vault-detail";
    detail.tabIndex = -1;
    detail.setAttribute("aria-label", "Item details");
    root.append(header, filters, listPane, detail);
    this.#workspace = {
      root,
      filters,
      views,
      itemFilters,
      types,
      folders,
      listPane,
      search,
      newItem,
      status,
      bulk,
      results,
      detail,
    };
    search.addEventListener("input", () => this.#renderResults(true));
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
    const { folders, types, views, itemFilters, newItem } = workspace;
    selectFilterOption(views, this.#view);
    selectFilterOption(types, String(this.#itemType ?? ""));

    const records = this.#vault?.folders ?? [];
    if (
      this.#folderId &&
      !records.some(({ folder }) => folder.id === this.#folderId)
    )
      this.#folderId = undefined;
    folders.replaceChildren();
    const addFolder = (label: string, id?: string) => {
      const value = id ?? "*";
      filterOption(folders, label, value, () => {
        if (this.#folderId === id) return;
        this.#folderId = id;
        selectFilterOption(folders, value);
        this.#renderResults(true);
      });
    };
    addFolder("All folders");
    addFolder("No folder", "");
    for (const { folder, title } of records) addFolder(title, folder.id);
    selectFilterOption(folders, this.#folderId ?? "*");
    const active = this.#view === "active";
    itemFilters.hidden = !active;
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
    const { search, results, bulk } = workspace;
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
            ((this.#itemType === undefined || item.type === this.#itemType) &&
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
    else {
      const remove = operation("Delete", "trash");
      remove.title = "Move to Trash";
      bulk.append(
        operation("Add to folder", "move"),
        view === "active"
          ? operation("Archive", "archive")
          : operation("Unarchive", "unarchive"),
        remove,
      );
    }
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
        vaultItemIcon(entry.item.type, entry.iconHost),
        create("span", entry.title ?? "Unreadable item"),
        create("small", itemTypes[entry.item.type].label),
      );
      row.append(select, open);
      list.append(row);
    }
    const filtered =
      view === "active" &&
      (this.#itemType !== undefined || this.#folderId !== undefined);
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

  async #readSnapshot(vault: UnlockedVault, signal: AbortSignal) {
    const response = await fetch(vaultItemsPath, { cache: "no-store", signal });
    if (!response.ok) throw new Error("Vault reload failed");
    const snapshot = decodeSnapshot(await response.json());
    if (snapshot.keyId !== vault.parameters.keyId)
      throw new Error("Vault key changed");
    return snapshot;
  }

  async #reload(vault: UnlockedVault, signal: AbortSignal) {
    return openSnapshot(await this.#readSnapshot(vault, signal), vault.key);
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
    const folder = this.#folderOptions();
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

  #attachmentList(
    item: Item,
    key: VaultKey,
    showError: (message: string) => void,
    remove?: (attachment: AttachmentMetadata) => void,
  ) {
    const list = create("ul");
    list.className = "vault-attachment-list";
    list.hidden = item.attachments.length === 0;
    for (const attachment of item.attachments) {
      const row = create("li");
      const filename = create("span", "Reading attachment…");
      const actions = create("div");
      const removeButton = remove && action("Remove", () => remove(attachment));
      if (removeButton) actions.append(removeButton);
      void decryptVaultText(attachment.name, key).then(
        (name) => {
          filename.textContent = name;
          const download = action("Download", () => {
            showError("");
            void this.#run(
              (signal) => openVaultAttachment(item.id, attachment, key, signal),
              (bytes) => {
                const file = new Blob([bytes], {
                  type: "application/octet-stream",
                });
                bytes.fill(0);
                downloadVaultFile(file, name);
              },
              () => showError("Could not read this attachment."),
              { blockNavigation: true },
            );
          });
          download.setAttribute("aria-label", `Download ${name}`);
          actions.prepend(download);
          removeButton?.setAttribute("aria-label", `Remove ${name}`);
        },
        () => {
          filename.textContent = "Unreadable attachment";
        },
      );
      row.append(filename, actions);
      list.append(row);
    }
    return list;
  }

  #editAttachments(
    { entry, details }: EditTarget,
    vault: UnlockedVault,
    onUpdate: (latest: ListedItem | undefined, canKeepEditing: boolean) => void,
  ) {
    let current = entry.item;
    const input = create("input");
    input.type = "file";
    const status = statusMessage("");
    const error = alert("");
    const showError = (message: string) => {
      error.textContent = message;
      error.hidden = !message;
    };
    error.hidden = true;

    const mutate = (
      write: (signal: AbortSignal) => Promise<void>,
      success: string,
      done?: () => void,
    ) => {
      showError("");
      status.textContent = "Updating attachments…";
      let problem =
        "Could not refresh attachments. Retry the attachment action.";
      void this.#run(
        async (signal) => {
          try {
            await write(signal);
          } catch (error) {
            problem =
              error instanceof Error
                ? error.message
                : "Could not update this attachment. Try again.";
            throw error;
          }
          const snapshot = await this.#readSnapshot(vault, signal);
          const active = snapshot.items.find(({ id }) => id === current.id);
          const item =
            active ?? snapshot.trash.find(({ id }) => id === current.id);
          if (!item) return { latest: undefined, canKeepEditing: false };
          const trashed = !active;
          // Attachment writes also bump the item revision. Keep the draft's
          // revision tied to the fields it originally loaded.
          const canKeepEditing = !trashed && sameEditableItem(current, item);
          const latest = canKeepEditing
            ? { ...entry, item }
            : await readListedItem(item, vault.key, trashed).catch(() => ({
                item,
                title: null,
                trashed,
              }));
          return { latest, canKeepEditing };
        },
        ({ latest, canKeepEditing }) => {
          if (latest) this.#rememberItem(vault, latest);
          else
            vault.entries = vault.entries.filter(
              ({ item }) => item.id !== current.id,
            );
          this.#renderResults();
          done?.();
          status.textContent = success;
          onUpdate(latest, canKeepEditing);
          if (canKeepEditing && latest) {
            current = latest.item;
            const next = this.#attachmentList(
              current,
              details.key,
              showError,
              remove,
            );
            list.replaceWith(next);
            list = next;
          } else fieldset.disabled = true;
        },
        () => {
          status.textContent = "";
          showError(problem);
        },
        { blockNavigation: true },
      );
    };
    const remove = ({ id }: AttachmentMetadata) =>
      mutate(
        (signal) => removeVaultAttachment(current.id, id, signal),
        "Attachment removed.",
      );
    let list = this.#attachmentList(current, details.key, showError, remove);
    let sealed: Awaited<ReturnType<typeof encryptVaultAttachment>> | undefined;
    const upload = action("Upload attachment", () => {
      const file = input.files?.[0];
      if (!file) return;
      mutate(
        async (signal) => {
          sealed ??= await encryptVaultAttachment(
            file,
            await unwrapVaultKey(current.wrappedKey, vault.key, "encrypt"),
          );
          signal.throwIfAborted();
          await uploadVaultAttachment(
            current.id,
            current.revision,
            vault.parameters.keyId,
            sealed,
            signal,
          );
        },
        "Attachment uploaded.",
        () => {
          sealed = undefined;
          input.value = "";
          upload.disabled = true;
        },
      );
    });
    upload.disabled = true;
    input.addEventListener("change", () => {
      sealed = undefined;
      upload.disabled = !input.files?.length;
    });
    const picker = create("div");
    picker.className = "vault-attachment-picker";
    picker.append(itemField(["Choose attachment", input]), upload);
    const hint = create("p", "Attachment changes are saved immediately.");
    hint.className = "vault-attachment-hint";
    const fieldset = vaultItemFieldset(
      "Attachments",
      list,
      picker,
      hint,
      status,
      error,
    );
    return fieldset;
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
        const trashed = !restoring;
        return readListedItem(item, vault.key, trashed).catch(() => ({
          item,
          title: null,
          trashed,
        }));
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

  #showItemTypes() {
    this.#stopWork();
    const choices = create("ul");
    choices.className = "vault-item-types";
    for (const type of allItemTypes) {
      const row = create("li");
      row.append(
        action(itemTypes[type].label, () => this.#showDetailedForm(type)),
      );
      choices.append(row);
    }
    this.#showPanel([
      this.#toolbar(this.#showBrowse),
      create("h2", "New item"),
      choices,
    ]);
  }

  #showDetailedForm(type: ItemType, edit?: EditTarget) {
    const editor = vaultItemEditor(
      type,
      edit?.details.properties ?? {},
      Boolean(edit?.entry.item.details.credentials?.fido2Credentials?.length),
    );
    this.#showItemForm(
      itemTypes[type].label,
      async (title, key, previous) => {
        const encrypt = async (itemKey: VaultKey) => ({
          type,
          name:
            previous && title === edit?.title
              ? previous.name
              : await encryptVaultText(title, itemKey),
          details: await editor.encrypt(itemKey, previous?.details),
        });
        return previous
          ? {
              expectedRevision: previous.revision,
              ...(await encrypt(
                await unwrapVaultKey(previous.wrappedKey, key, "encrypt"),
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
    encrypt: (title: string, key: VaultKey, previous?: Item) => Promise<object>,
    edit: EditTarget | undefined,
    properties: HTMLElement,
  ) {
    const vault = this.#vault;
    if (!vault) return;
    this.#stopWork();
    const form = create("form");
    form.className = "vault-item-form";
    form.method = "post";
    form.autocomplete = "off";
    const title = create("input");
    title.required = true;
    title.value = edit?.title ?? "";
    const folder = this.#folderOptions();
    folder.setAttribute("aria-label", "Folder");
    const initialFolder = edit?.entry.item.folderId;
    if (
      initialFolder &&
      !Array.from(folder.options).some(({ value }) => value === initialFolder)
    )
      folder.add(new Option("Unreadable folder", initialFolder));
    folder.value = initialFolder ?? "";
    let editingEntry = edit?.entry;
    let cancelEntry = editingEntry;
    let conflict = false;
    const item =
      label === "Login" ? "login" : label === "Secure Note" ? "note" : "item";
    const saveLabel = `Save ${label}`;
    const save = create("button", saveLabel);
    save.type = "submit";
    const error = alert("");
    error.hidden = true;
    const setBusy = (status?: string) => {
      const busy = status !== undefined;
      save.disabled = busy || conflict;
      title.readOnly = folder.disabled = busy;
      properties
        .querySelectorAll<HTMLInputElement>("input, textarea, select, button")
        .forEach((input) => {
          input.disabled = busy;
        });
      save.textContent = status ?? saveLabel;
      if (reload) reload.disabled = busy;
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
            const active = snapshot.items.find(
              ({ id }) => id === edit.entry.item.id,
            );
            const latest =
              active ??
              snapshot.trash.find(({ id }) => id === edit.entry.item.id);
            return latest?.type === edit.entry.item.type
              ? readListedItem(latest, vault.key, active === undefined)
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
                ({ item }) => item.id !== edit.entry.item.id,
              );
              this.#showBrowse(`This ${item} is no longer in your vault.`);
            }
          },
          () => showError(failure),
          { blockNavigation: true },
        );
      });
    // Reuse the encrypted request if a save may have reached D1 before it failed.
    let sealed: string | undefined;
    const clearSealed = () => {
      sealed = undefined;
      title.setCustomValidity("");
    };
    form.addEventListener("input", (event) => {
      if (!(
        event.target instanceof HTMLInputElement && event.target.type === "file"
      ))
        clearSealed();
    });
    folder.addEventListener("change", clearSealed);

    form.append(
      vaultItemFieldset(
        "Item details",
        vaultField({ label: "Title", value: title }).element,
        itemField(["Folder", folder]),
      ),
      properties,
    );
    if (edit) {
      form.append(
        this.#editAttachments(edit, vault, (latest, canKeepEditing) => {
          cancelEntry = latest;
          if (canKeepEditing && latest) {
            if (editingEntry?.item.revision !== latest.item.revision)
              sealed = undefined;
            editingEntry = latest;
            return;
          }
          conflict = true;
          if (reload) reload.hidden = false;
          showError(
            `This ${item} changed since you opened it. Your draft is still here.`,
          );
        }),
      );
    }
    form.append(save, error);
    if (reload) {
      reload.hidden = true;
      form.append(reload);
    }
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
            ...(await encrypt(
              title.value.trim(),
              vault.key,
              editingEntry?.item,
            )),
            ...(folder.value !== (editingEntry?.item.folderId ?? "")
              ? { folderId: folder.value || null }
              : {}),
          });
          signal.throwIfAborted();
          if (sealed.length > vaultItemBodyLimit) {
            failure = `This ${item} is too large to save.`;
            throw new Error("Encrypted item exceeds request limit");
          }
          const response = await fetch(
            edit ? vaultItemPath(edit.entry.item.id) : vaultItemsPath,
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
          return readListedItem(decodeItem(await response.json()), vault.key);
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
      if (edit && cancelEntry && !conflict)
        this.#showDetails(cancelEntry, edit.details);
      else if (cancelEntry) {
        if (cancelEntry.trashed) this.#showTrash();
        else this.#open(cancelEntry);
      } else this.#showBrowse();
    });
    this.#showPanel(
      [
        this.#toolbar(undefined, cancel),
        create("h2", edit ? "Edit" : `New ${label}`),
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

  #itemDetailFieldsets(item: Item, { properties, key }: ItemDetails) {
    const content: HTMLElement[] = [];
    const addFields = (label: string, rows: readonly DetailRow[]) => {
      if (rows.length)
        content.push(vaultItemFieldset(label, detailFields(rows)));
    };
    const folder = this.#vault?.folders.find(
      ({ folder }) => folder.id === item.folderId,
    );
    const metadata: DetailRow[] = [];
    if (folder) metadata.push({ label: "Folder", value: folder.title });
    if (properties.favorite)
      metadata.push({ label: "Favourite", value: "Yes", copyable: false });
    if (properties.reprompt === 1)
      metadata.push({
        label: "Master password reprompt",
        value: "Required",
        copyable: false,
      });
    addFields("Item details", metadata);

    if (item.type === 1) {
      const credentials = properties.credentials;
      const rows: DetailRow[] = [];
      if (credentials?.username)
        rows.push({ label: "Username", value: credentials.username });
      if (credentials?.password)
        rows.push({
          label: "Password",
          value: credentials.password,
          visibility: "masked",
          revealLabel: "password",
        });
      if (item.details.credentials?.fido2Credentials?.length)
        rows.push({
          label: "Passkey",
          value: "Saved in this login",
          copyable: false,
        });
      if (credentials?.totp)
        rows.push({
          label: "TOTP seed",
          value: credentials.totp,
          visibility: "masked",
        });
      addFields("Login credentials", rows);
      addFields(
        "Autofill options",
        (credentials?.uris ?? []).flatMap(({ uri, match }) =>
          uri == null
            ? []
            : [
                {
                  label: "Website",
                  value: uri,
                  suffix:
                    match == null ? undefined : ` (${uriMatchLabels[match]})`,
                },
              ],
        ),
      );
    } else if (item.type === 4) {
      for (const { label, rows } of identityDisplayGroups(properties.data))
        addFields(label, rows);
    } else if (item.type !== 2) {
      const { label, rows } = structuredDisplayGroup(
        item.type,
        properties.data,
      );
      addFields(label, rows);
    }

    if (properties.notes)
      content.push(
        vaultItemFieldset(
          "Notes",
          vaultField({ label: "Notes", value: properties.notes }).element,
        ),
      );
    const history = item.details.passwordHistory;
    if (history?.length) {
      const output = create("div");
      const show = action("Show password history", () => {
        void this.#run(
          () =>
            Promise.all(
              history.map(async ({ password, lastUsedDate }) => ({
                password: await readText(password ?? null, key),
                lastUsedDate,
              })),
            ),
          (entries) => {
            const list = create("ul");
            list.className = "vault-password-history";
            for (const { password, lastUsedDate } of entries) {
              if (password === null) continue;
              const row = create("li");
              if (lastUsedDate) {
                const date = create(
                  "time",
                  new Date(lastUsedDate).toLocaleDateString(),
                );
                date.dateTime = lastUsedDate;
                row.append(date);
              }
              row.append(
                vaultField({
                  label: "previous password",
                  value: password,
                  masked: true,
                }).element,
              );
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
      content.push(vaultItemFieldset("Password history", output));
    }
    addFields(
      "Custom fields",
      (properties.fields ?? []).map(
        ({ name, value, type, linkedId }): DetailRow => ({
          label: name || "Custom field",
          value:
            type === 3
              ? linkedId == null
                ? "Linked field"
                : linkedFieldLabel(item.type, linkedId)
              : (value ?? ""),
          visibility: type === 1 && value != null ? "masked" : "visible",
          copyable: type !== 3,
        }),
      ),
    );
    if (item.attachments.length) {
      const body = create("div");
      const error = alert("");
      error.hidden = true;
      body.append(
        this.#attachmentList(item, key, (message) => {
          error.textContent = message;
          error.hidden = !message;
        }),
        error,
      );
      content.push(vaultItemFieldset("Attachments", body));
    }
    return content.length
      ? content
      : [create("p", "This item has no details.")];
  }

  #showDetails(entry: ListedItem, details: ItemDetails | null, error?: string) {
    const { item, title, trashed } = entry;
    const titleNode = create("h2", title ?? "Unreadable item");
    titleNode.tabIndex = -1;
    const edit =
      !trashed && title !== null && details
        ? action("Edit", () =>
            this.#showDetailedForm(item.type, { entry, title, details }),
          )
        : undefined;
    const remove = action(trashed ? "Restore" : "Delete", () =>
      this.#changeLifecycle(entry, details),
    );
    if (!trashed) remove.title = "Move to Trash";
    const archive = item.archivedAt === null;
    const archiveOrPurge = trashed
      ? action("Permanently delete", () =>
          this.#startBulk("trash", [entry], "purge"),
        )
      : action(archive ? "Archive" : "Unarchive", () =>
          this.#startBulk(
            this.#viewFor(entry),
            [entry],
            archive ? "archive" : "unarchive",
          ),
        );
    if (!trashed)
      archiveOrPurge.title = archive ? "Archive item" : "Unarchive item";
    this.#showPanel([
      this.#toolbar(this.#showBrowse, edit, remove, archiveOrPurge),
      titleNode,
      ...(error ? [alert(error)] : []),
      ...(details ? this.#itemDetailFieldsets(item, details) : []),
    ]);
    if (this.#workspace?.detail === document.activeElement) titleNode.focus();
  }
}

customElements.define(vaultReader.tag, VaultReader);
