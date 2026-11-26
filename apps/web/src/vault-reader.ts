import {
  actionBar,
  buttonClassName,
  createAlert,
  createButtonGroup,
  createField,
  createFieldGroup,
  createFileInput,
  createNativeSelect,
  inputClassName,
  sidebarClassNames,
  sidebarItemClassName,
} from "@orumai/ui";
import { Schema } from "effect";
import { CustomElement } from "foldkit";
import {
  decryptItemDetails,
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
  itemTypes,
  type ItemType,
  vaultItemTypeOrder,
} from "./vault-item-content.ts";
import { linkedFieldLabel, vaultItemEditor } from "./vault-item-editor.ts";
import { webLinkHref } from "./links-client.ts";
import { vaultField } from "./vault-field.ts";
import {
  vaultFolderIcon,
  vaultIcon,
  vaultItemIcon,
  vaultItemIconSrc,
  vaultItemPaths,
} from "./vault-item-icon.ts";
import {
  peopleApiPath,
  PeopleList,
  type PersonSummary,
} from "./people-contract.ts";
import { companyForHostname } from "./company-domains.ts";
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
import { mountVaultMoveMenu } from "./vault-move-menu.ts";
import {
  mountVaultItemList,
  vaultRowActions,
  vaultRowCheckboxId,
  vaultRowFocus,
} from "./vault-item-list.ts";
import { mountVaultWorkspaceHeader } from "./vault-workspace-header.ts";

export const vaultReader = CustomElement.define({
  tag: "orumai-vault-reader",
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
const viewIcons = {
  active: ["M3 7h18v13H3zM7 7V4h10v3"],
  archive: ["M4 8h16v11H4zM3 4h18v4H3zM10 12h4"],
  trash: ["M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 4v6m4-6v6"],
} as const;
type Folder = typeof VaultFolder.Type;
type ListedFolder = { folder: Folder; title: string };
type BulkAction = (typeof VaultBulkChange.Type)["kind"];
type BulkLifecycleAction = Exclude<BulkAction, "move">;
type EditTarget = { entry: ListedItem; title: string; details: ItemDetails };
type ItemField = readonly [
  label: string,
  input: HTMLInputElement | HTMLTextAreaElement,
];
type UnlockedVault = {
  parameters: Omit<Snapshot, "items" | "trash" | "folders">;
  key: VaultKey;
  entries: ListedItem[];
  folders: ListedFolder[];
  companies: readonly PersonSummary[];
};
type VaultWorkspace = {
  root: HTMLElement;
  header: ReturnType<typeof mountVaultWorkspaceHeader>;
  filters: HTMLElement;
  views: HTMLUListElement;
  itemFilters: HTMLElement;
  types: HTMLUListElement;
  folders: HTMLUListElement;
  listPane: HTMLElement;
  search: HTMLInputElement;
  status: HTMLElement;
  bulk: HTMLElement;
  results: HTMLElement;
  detail: HTMLElement;
  detailContent: HTMLElement;
};
type UnlockFailure = { message: string; invalidPassword?: true };

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
  button.dataset.slot = "button";
  button.className = buttonClassName({ variant: "outline", size: "sm" });
  button.addEventListener("click", () => run());
  return button;
};
const itemSummary = (
  label: string,
  type: ItemType,
  iconHost: string | undefined,
  buttons: readonly HTMLButtonElement[],
  company?: PersonSummary,
) => {
  const element = create("header");
  element.className = "vault-item-summary";
  const row = create("div");
  row.className = "vault-item-summary-row";
  const title = create("h2");
  title.tabIndex = -1;
  title.append(vaultItemIcon(type, iconHost, company), create("span", label));
  const group = createButtonGroup(buttons);
  group.setAttribute("aria-label", "Item actions");
  const actions = create("div");
  actions.className = "vault-item-summary-actions";
  actions.append(group);
  row.append(title, actions);
  element.append(row);
  return { element, title };
};
const filterList = (label: string) => {
  const list = create("ul");
  list.className = sidebarClassNames.list;
  list.setAttribute("role", "list");
  list.setAttribute("aria-label", label);
  return list;
};
const filterOption = (
  list: HTMLUListElement,
  label: string,
  value: string,
  select: () => void,
  icon: SVGSVGElement,
) => {
  const button = action("", () => {
    button.focus({ preventScroll: true });
    select();
  });
  button.className = sidebarItemClassName(false, true);
  button.dataset.slot = "navigation-link";
  const content = create("span");
  content.className = sidebarClassNames.label;
  content.append(icon, label);
  button.append(content);
  button.value = value;
  const option = create("li");
  option.append(button);
  list.append(option);
};
const selectFilterOption = (list: HTMLUListElement, value: string) => {
  for (const button of list.querySelectorAll("button")) {
    const current = button.value === value;
    button.className = sidebarItemClassName(current, true);
    if (current) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
};
type DetailRow = {
  label: string;
  value: string;
  href?: string;
  visibility?: "visible" | "masked";
  actionLabel?: string;
  copyable?: boolean;
};
const detailFields = (rows: readonly DetailRow[]) =>
  rows.map(
    ({ label, value, href, visibility, actionLabel, copyable }) =>
      vaultField({
        label,
        value,
        href,
        masked: visibility === "masked",
        actionLabel,
        copyable,
      }).element,
  );
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

const transferPassword = (label: string, required = true) => {
  const input = create("input");
  input.type = "password";
  input.required = required;
  input.maxLength = vaultPasswordMaximum;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.dataset.slot = "input";
  input.className = inputClassName;
  return {
    input,
    element: createField({ label, content: input, control: input }),
  };
};

const primarySubmit = (label: string) => {
  const button = create("button", label);
  button.type = "submit";
  button.dataset.slot = "button";
  button.className = buttonClassName({ variant: "primary" });
  return button;
};

const passwordForm = (
  buttonLabel: string,
  submit: (password: string) => void,
) => {
  const form = create("form");
  form.method = "post";
  form.className = "vault-password-form";
  const { element, input } = transferPassword("Vault master password");
  input.enterKeyHint = "go";
  const button = primarySubmit(buttonLabel);
  form.append(element, button);
  // The password stays out of native form submissions and the app's message history.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (input.readOnly) return;
    const password = input.value;
    form.reset();
    submit(password);
  });
  return { form, input, button };
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

const loadCompanies = async (
  signal?: AbortSignal,
): Promise<readonly PersonSummary[]> => {
  // Fetch only contact data. Decrypted vault hostnames are matched locally.
  try {
    const response = await fetch(`${peopleApiPath}?kind=company`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) return [];
    const result = Schema.decodeUnknownOption(PeopleList)(
      await response.json(),
    );
    return result._tag === "Some"
      ? result.value.people.filter((person) => person.kind === "company")
      : [];
  } catch {
    return [];
  }
};

const openSnapshot = async (
  snapshot: Snapshot,
  key: VaultKey,
  signal?: AbortSignal,
): Promise<UnlockedVault> => {
  const { items, trash, folders, ...parameters } = snapshot;
  const [entries, listedFolders, companies] = await Promise.all([
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
    loadCompanies(signal),
  ]);
  return {
    parameters,
    key,
    entries,
    companies,
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
  #checked = new Set<string>();
  #panelBack: (() => void) | undefined;
  #disposeMoveMenu: (() => void) | undefined;
  #disposeItemList: (() => void) | undefined;
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
    this.#disposeMoveMenu?.();
    this.#disposeMoveMenu = undefined;
    this.#disposeItemList?.();
    this.#disposeItemList = undefined;
    this.#workspace?.header.dispose();
    this.#workspace = null;
    this.#view = "active";
    this.#itemType = undefined;
    this.#folderId = undefined;
    this.#selectedId = undefined;
    this.#checked.clear();
    this.#panelBack = undefined;
    this.querySelectorAll("form").forEach((form) => form.reset());
    this.replaceChildren();
  }

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
    const { root, header, filters, listPane, detail } = workspace;
    const hasPanel = root.hasAttribute("data-panel");
    const editing = detail.classList.contains("vault-editor");
    filters.inert = this.#busy || editing;
    listPane.inert = this.#busy || hasPanel;
    detail.inert = this.#busy || !hasPanel;
    header.update({
      title: vaultViews[this.#view],
      showBack: this.#panelBack !== undefined,
      showFilters: !editing,
      showNew: !editing && this.#view === "active",
      busy: this.#busy,
    });
  }

  #showUnlock(failure?: UnlockFailure) {
    const errorId = "vault-unlock-error";
    const feedback = failure
      ? createAlert({
          message: failure.message,
          messageId: errorId,
          severity: "error",
          announcement: "static",
        })
      : undefined;
    const { form, input, button } = passwordForm("Unlock vault", (password) => {
      feedback?.remove();
      input.removeAttribute("aria-describedby");
      input.removeAttribute("aria-invalid");
      input.readOnly = true;
      button.textContent = "Unlocking vault…";
      button.setAttribute("aria-disabled", "true");
      form.setAttribute("aria-busy", "true");
      let error: UnlockFailure = {
        message: "Could not load your vault. Try again.",
      };
      void this.#run(
        async (signal) => {
          const response = await fetch(vaultItemsPath, {
            cache: "no-store",
            signal,
          });
          if (response.status === 401)
            error = { message: "Sign in to Orumai to open your vault." };
          if (!response.ok) throw new Error("Vault fetch failed");
          const snapshot = decodeSnapshot(await response.json());
          error = {
            message: "Could not unlock the vault. Check your master password.",
            invalidPassword: true,
          };
          const key = await unlockVault(password, snapshot);
          signal.throwIfAborted();
          return openSnapshot(snapshot, key, signal);
        },
        (vault) => {
          this.#vault = vault;
          this.#mountWorkspace();
          this.#showItems("active");
        },
        () => this.#showUnlock(error),
      );
    });
    form.classList.add("vault-unlock-form");
    if (feedback) {
      input.setAttribute("aria-describedby", errorId);
      if (failure?.invalidPassword) input.setAttribute("aria-invalid", "true");
      form.insertBefore(feedback, button);
    }
    this.replaceChildren(form);
    input.focus({ preventScroll: true });
  }

  #toolbar(...actions: (HTMLElement | undefined)[]) {
    const toolbar = create("div");
    toolbar.className = "vault-toolbar";
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

  #mountWorkspace() {
    const root = create("div");
    root.className = "vault-workspace workspace workspace-stacked";
    const headerMount = create("div");
    headerMount.id = "vault-workspace-controls";
    headerMount.className = "vault-header-mount";

    const sidebar = create("div");
    sidebar.className = "workspace-sidebar";
    const filters = create("nav");
    filters.className = "vault-filters";
    filters.setAttribute("aria-label", "Vault navigation");
    sidebar.append(filters);
    const views = filterList("Vault views");
    for (const view of Object.keys(vaultViews) as VaultView[])
      filterOption(
        views,
        vaultViews[view],
        view,
        () => this.#afterClosingFilters(() => this.#showItems(view)),
        vaultIcon(viewIcons[view]),
      );

    const types = filterList("Item types");
    const addType = (label: string, kind?: ItemType) => {
      const value = String(kind ?? "");
      filterOption(
        types,
        label,
        value,
        () =>
          this.#afterClosingFilters(() => {
            if (this.#panelBack) this.#showBrowse();
            if (this.#itemType === kind) return;
            this.#itemType = kind;
            selectFilterOption(types, value);
            this.#renderResults(true);
          }),
        vaultIcon(kind === undefined ? viewIcons.active : vaultItemPaths[kind]),
      );
    };
    addType("All types");
    for (const kind of vaultItemTypeOrder) addType(itemTypes[kind].label, kind);
    const folders = filterList("Folders");
    const itemFilters = create("div");
    itemFilters.className = "vault-item-filters";
    itemFilters.append(types, folders);
    const tools = filterList("Vault tools");
    tools.classList.add("vault-nav-tools");
    for (const [label, open, icon] of [
      [
        "Import",
        () => this.#showImport(),
        vaultIcon(["M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"]),
      ],
      [
        "Export",
        () => this.#showExport(),
        vaultIcon(["M12 15V3m-5 5 5-5 5 5M4 16v4h16v-4"]),
      ],
      ["Manage folders", () => this.#showFolders(), vaultFolderIcon()],
    ] as const) {
      filterOption(
        tools,
        label,
        label,
        () =>
          this.#afterClosingFilters(() => {
            this.#stopWork();
            this.#selectItem();
            open();
          }),
        icon,
      );
    }
    filters.append(views, itemFilters, tools);

    const listPane = create("section");
    listPane.className = "vault-list-pane workspace-list";
    listPane.setAttribute("aria-label", "Vault items");
    const listHeader = create("div");
    listHeader.className = "vault-list-header";
    const search = create("input");
    search.type = "search";
    search.dataset.slot = "input";
    search.className = inputClassName;
    search.placeholder = "Search items";
    search.setAttribute("aria-label", "Search items by title");
    search.autocomplete = "off";
    search.spellcheck = false;
    listHeader.append(search);
    const status = create("div");
    status.className = "vault-list-status";
    const bulk = create("footer");
    bulk.className = "vault-bulk";
    bulk.hidden = true;
    const results = create("div");
    results.className = "vault-results workspace-results";
    listPane.append(listHeader, status, results, bulk);
    listPane.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented || bulk.hidden)
        return;
      event.preventDefault();
      bulk
        .querySelector<HTMLButtonElement>('[data-slot="action-bar-close"]')
        ?.click();
    });

    const detail = create("section");
    detail.className = "vault-detail workspace-detail";
    detail.tabIndex = -1;
    detail.setAttribute("aria-label", "Item details");
    const detailContent = create("div");
    detailContent.className = "vault-detail-content";
    detail.append(detailContent);
    root.append(headerMount, sidebar, listPane, detail);
    this.replaceChildren(root);
    const header = mountVaultWorkspaceHeader(headerMount, sidebar, filters, {
      newItem: (type) => {
        if (
          this.#busy ||
          detail.classList.contains("vault-editor") ||
          this.#view !== "active"
        )
          return;
        this.#stopWork();
        this.#selectItem();
        this.#showDetailedForm(type);
      },
      back: () => {
        if (this.#busy || !this.#panelBack) return;
        this.#stopWork();
        this.#panelBack();
      },
    });
    this.#workspace = {
      root,
      header,
      filters,
      views,
      itemFilters,
      types,
      folders,
      listPane,
      search,
      status,
      bulk,
      results,
      detail,
      detailContent,
    };
    search.addEventListener("input", () => this.#renderResults(true));
  }

  #afterClosingFilters(run: () => void) {
    const workspace = this.#workspace;
    const dialog = workspace?.filters.closest("dialog");
    if (workspace && dialog?.open) {
      dialog.addEventListener(
        "close",
        () => {
          if (this.#workspace === workspace) run();
        },
        { once: true },
      );
      workspace.header.closeFilters();
    } else run();
  }

  #showPanel(
    nodes: HTMLElement[],
    { editing = false, back }: { editing?: boolean; back?: () => void } = {},
  ) {
    const workspace = this.#workspace;
    if (!workspace) return;
    workspace.root.dataset.panel = "";
    this.#panelBack = back;
    workspace.detail.classList.toggle("vault-editor", editing);
    workspace.detailContent.replaceChildren(...nodes);
    workspace.detail.scrollTop = 0;
    this.#updateNavigation();
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
    const { folders, types, views, itemFilters } = workspace;
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
      filterOption(
        folders,
        label,
        value,
        () =>
          this.#afterClosingFilters(() => {
            if (this.#panelBack) this.#showBrowse();
            if (this.#folderId === id) return;
            this.#folderId = id;
            selectFilterOption(folders, value);
            this.#renderResults(true);
          }),
        id === undefined ? vaultIcon(viewIcons.active) : vaultFolderIcon(),
      );
    };
    addFolder("All folders");
    addFolder("No folder", "");
    for (const { folder, title } of records) addFolder(title, folder.id);
    selectFilterOption(folders, this.#folderId ?? "*");
    const active = this.#view === "active";
    itemFilters.hidden = !active;
  }

  #showItems(
    view: VaultView,
    message?: string,
    problem?: string,
    rowFocus?: readonly string[],
  ) {
    this.#stopWork();
    const workspace = this.#workspace;
    if (!workspace) return;
    const { root, detail, detailContent, search, status, results } = workspace;
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
    this.#panelBack = undefined;
    detail.classList.remove("vault-editor");
    detailContent.replaceChildren();
    this.#updateNavigation();
    if (changed) {
      this.#updateFilters();
      if (!rowFocus) this.#checked.clear();
      this.#renderResults(resetScroll, rowFocus);
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
    if (
      !workspace.filters.contains(document.activeElement) &&
      !document.activeElement?.closest(
        ".vault-workspace .workspace-drawer-trigger",
      )
    )
      (rowFocus?.map(vaultRowFocus).find(Boolean) ?? previous ?? search).focus({
        preventScroll: true,
      });
  }

  #renderResults(resetScroll = false, rowFocus?: readonly string[]) {
    const vault = this.#vault;
    const workspace = this.#workspace;
    if (!vault || !workspace) return;
    const { search, results, bulk } = workspace;
    const view = this.#view;
    const query = search.value.trim().toLowerCase();
    const scroll = resetScroll ? 0 : results.scrollTop;
    const list = create("div");
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
    const selected = this.#checked;
    if (resetScroll) selected.clear();
    const entryIds = new Set(entries.map(({ item }) => item.id));
    for (const id of selected) if (!entryIds.has(id)) selected.delete(id);
    const selectedEntries = () =>
      entries.filter(({ item }) => selected.has(item.id));
    this.#disposeItemList?.();
    this.#disposeItemList = undefined;
    this.#disposeMoveMenu?.();
    this.#disposeMoveMenu = undefined;
    bulk.hidden = true;
    const moveMenu = view === "trash" ? undefined : create("div");
    let lastCheckbox: HTMLInputElement | undefined;
    const operation = (label: string, kind: BulkLifecycleAction) => ({
      label,
      ...(kind === "trash" ? { title: "Move to Trash" } : {}),
      destructive: kind === "trash" || kind === "purge",
      onSelect: () => this.#startBulk(view, selectedEntries(), kind),
    });
    const bar = actionBar({
      label: "Selected item actions",
      menu: moveMenu,
      actions: moveMenu
        ? [
            view === "active"
              ? operation("Archive", "archive")
              : operation("Unarchive", "unarchive"),
            operation("Delete", "trash"),
          ]
        : [
            operation("Restore selected", "restore"),
            operation("Permanently delete selected", "purge"),
          ],
      onClear: () => {
        const focusWasInBar = bar.element.contains(document.activeElement);
        selected.clear();
        for (const checkbox of list.querySelectorAll<HTMLInputElement>(
          "input:checked",
        ))
          checkbox.checked = false;
        updateSelection();
        if (focusWasInBar)
          (lastCheckbox ?? search).focus({ preventScroll: true });
      },
    });
    const updateSelection = () => {
      bar.setCount(selected.size);
      bulk.hidden = selected.size === 0;
      if (!bulk.hidden && moveMenu && !this.#disposeMoveMenu) {
        this.#disposeMoveMenu = mountVaultMoveMenu(
          moveMenu,
          vault.folders,
          (folderId) =>
            this.#applyBulk(view, selectedEntries(), "move", folderId),
        );
      }
    };
    bulk.replaceChildren(bar.element);
    const filtered =
      view === "active" &&
      (this.#itemType !== undefined || this.#folderId !== undefined);
    const empty = create(
      "p",
      query || filtered ? "No matching items." : "No items in this view.",
    );
    empty.className = "vault-empty";
    empty.setAttribute("role", "status");
    results.replaceChildren(entries.length ? list : empty);
    updateSelection();
    if (entries.length) {
      // Foldkit replaces its mount node. Keep a stable parent for this result set.
      const mount = create("div");
      list.append(mount);
      this.#disposeItemList = mountVaultItemList(
        mount,
        entries.map(({ item, title, iconHost }) => ({
          id: item.id,
          title: title ?? "Unreadable item",
          type: item.type,
          icon: vaultItemIconSrc(
            item.type,
            iconHost,
            companyForHostname(vault.companies, iconHost),
          ),
          actions: vaultRowActions(view, title !== null),
        })),
        selected,
        ({ key, action }) => {
          if (!list.isConnected || this.#busy || workspace.listPane.inert)
            return;
          const entry = this.#vault?.entries.find(
            ({ item }) => item.id === key,
          );
          if (!entry || this.#viewFor(entry) !== view) return;
          if (action === "selection") {
            const checkbox = document.getElementById(vaultRowCheckboxId(key));
            if (!(checkbox instanceof HTMLInputElement)) return;
            lastCheckbox = checkbox;
            if (checkbox.checked) selected.add(key);
            else selected.delete(key);
            updateSelection();
          } else if (action === "open") {
            this.#open(entry);
          } else if (
            vaultRowActions(view, entry.title !== null).includes(action)
          ) {
            const index = entries.findIndex(({ item }) => item.id === key);
            const focus = [
              key,
              entries[index + 1]?.item.id,
              entries[index - 1]?.item.id,
            ].filter((id) => id !== undefined);
            if (action === "edit") this.#open(entry, { edit: true });
            else if (action === "move") this.#showMoveItem(entry, focus);
            else if (action === "trash" || action === "restore")
              this.#changeLifecycle(entry, null, focus);
            else this.#startBulk(view, [entry], action, focus);
          }
        },
        () => {
          if (!list.isConnected) return;
          results.scrollTop = scroll;
          this.#selectItem(this.#selectedId);
          if (
            rowFocus &&
            (document.activeElement === search ||
              document.activeElement === document.body)
          )
            rowFocus
              .map(vaultRowFocus)
              .find(Boolean)
              ?.focus({ preventScroll: true });
        },
      );
    }
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
    return openSnapshot(
      await this.#readSnapshot(vault, signal),
      vault.key,
      signal,
    );
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
          alert(
            "Could not reload your vault. Reload the page and unlock it again.",
          ),
        ),
      { blockNavigation: true },
    );
  }

  #startBulk(
    view: VaultView,
    entries: ListedItem[],
    kind: BulkLifecycleAction,
    rowFocus?: readonly string[],
  ) {
    this.#stopWork();
    const execute = () => this.#applyBulk(view, entries, kind, null, rowFocus);
    if (kind === "purge") {
      const back = () => this.#showItems(view, undefined, undefined, rowFocus);
      this.#showPanel(
        [
          create(
            "h2",
            rowFocus ? "Permanently delete item?" : "Permanently delete items?",
          ),
          create(
            "p",
            rowFocus
              ? `Permanently delete “${entries[0]?.title ?? "Unreadable item"}”? This cannot be undone.`
              : `Delete ${entries.length} selected item(s) permanently. This cannot be undone.`,
          ),
          action("Permanently delete", execute),
          action("Cancel", back),
        ],
        { back },
      );
    } else execute();
  }

  #applyBulk(
    view: VaultView,
    entries: ListedItem[],
    kind: BulkAction,
    folderId: string | null = null,
    rowFocus?: readonly string[],
  ) {
    const vault = this.#vault;
    const workspace = this.#workspace;
    if (!vault || !workspace || this.#busy || !entries.length) return;
    const subject = rowFocus ? "Item" : "Items";
    let problem = rowFocus
      ? "Could not update this item. Try again."
      : "Could not update the selected items. Try again.";
    if (kind === "move" && !rowFocus)
      workspace.status.replaceChildren(statusMessage("Moving items…"));
    else this.#showPanel([statusMessage("Updating items…")]);
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
          kind === "move"
            ? `${subject} moved.`
            : kind === "purge"
              ? `${subject} permanently deleted.`
              : `${subject} updated.`,
          undefined,
          rowFocus,
        );
      },
      () => this.#showItems(view, undefined, problem, rowFocus),
      { blockNavigation: true },
    );
  }

  #folderSelect(vault: UnlockedVault, initialFolder: string) {
    const options = [
      { value: "", label: "No folder" },
      ...vault.folders.map(({ folder, title }) => ({
        value: folder.id,
        label: title,
      })),
    ];
    if (initialFolder && !options.some(({ value }) => value === initialFolder))
      options.push({ value: initialFolder, label: "Unreadable folder" });
    return createNativeSelect({
      label: "Folder",
      options,
      value: initialFolder,
    });
  }

  #showMoveItem(entry: ListedItem, rowFocus: readonly string[]) {
    const vault = this.#vault;
    if (!vault) return;
    const view = this.#viewFor(entry);
    const back = () => this.#showItems(view, undefined, undefined, rowFocus);
    const { element, select } = this.#folderSelect(
      vault,
      entry.item.folderId ?? "",
    );
    const form = create("form");
    form.method = "post";
    form.append(
      element,
      this.#toolbar(action("Cancel", back), primarySubmit("Move")),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#applyBulk(view, [entry], "move", select.value || null, rowFocus);
    });
    this.#showPanel(
      [create("h2", `Move “${entry.title ?? "Unreadable item"}”`), form],
      { back },
    );
    select.focus();
  }

  #showImport() {
    const vault = this.#vault;
    if (!vault) return;
    const form = create("form");
    form.method = "post";
    const { element: fileField, input: file } = createFileInput({
      label: "Bitwarden export file",
      accept: ".csv,.json,text/csv,application/json",
      required: true,
    });
    const { element: passwordField, input: password } = transferPassword(
      "File password, if protected",
      false,
    );
    const review = primarySubmit("Review import");
    const error = alert("");
    error.hidden = true;
    form.append(fileField, passwordField, review, error);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const selected = file.files?.[0];
      if (!selected || review.disabled) return;
      const secret = password.value;
      password.value = "";
      error.hidden = true;
      review.disabled = true;
      review.textContent = "Preparing import…";
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
          review.textContent = "Review import";
          error.textContent = problem;
          error.hidden = false;
        },
      );
    });
    this.#showPanel([create("h2", "Import into your vault"), form], {
      back: this.#showBrowse,
    });
    file.focus();
  }

  #confirmImport(prepared: { body: string; items: number; folders: number }) {
    const vault = this.#vault;
    if (!vault) return;
    const error = alert("");
    error.hidden = true;
    const submit = action("Import items", () => {
      submit.disabled = true;
      submit.textContent = "Importing…";
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
          submit.textContent = "Import items";
          error.textContent = failure;
          error.hidden = false;
        },
        { blockNavigation: true },
      );
    });
    this.#showPanel(
      [
        create("h2", "Review import"),
        create(
          "p",
          `Import ${prepared.items} item(s) and ${prepared.folders} folder(s). Importing the same file again creates copies.`,
        ),
        submit,
        error,
      ],
      { back: () => this.#showImport() },
    );
    submit.focus();
  }

  #showExport() {
    const vault = this.#vault;
    if (!vault) return;
    const form = create("form");
    form.method = "post";
    const { element: formatField, select: format } = createNativeSelect({
      label: "File format",
      value: "json",
      options: [
        { value: "json", label: "Bitwarden JSON" },
        { value: "csv", label: "Bitwarden CSV" },
        { value: "zip", label: "Bitwarden ZIP with attachments" },
        { value: "protected", label: "Password-protected Bitwarden JSON" },
      ],
    });
    const { element: masterField, input: master } = transferPassword(
      "Vault master password",
    );
    const { element: secretField, input: secret } =
      transferPassword("Export password");
    const { element: repeatField, input: repeat } = transferPassword(
      "Confirm export password",
    );
    const encryption = create("fieldset");
    encryption.className = "vault-export-passwords";
    const warning = create("p");
    encryption.append(secretField, repeatField);
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
    const submit = primarySubmit("Download export");
    const error = alert("");
    error.hidden = true;
    form.append(formatField, warning, encryption, masterField, submit, error);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      if (format.value === "protected" && secret.value !== repeat.value) {
        error.textContent = "The export passwords must match.";
        error.hidden = false;
        return;
      }
      submit.disabled = true;
      submit.textContent = "Preparing export…";
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
            downloadVaultFile(result.archive, "orumai-vault.zip");
            if (result.failed.length) {
              const missing = create("ul");
              for (const name of result.failed)
                missing.append(create("li", name));
              this.#showPanel(
                [
                  alert(
                    `The ZIP contains ${result.count} attachment(s). ${result.failed.length} could not be included.`,
                  ),
                  missing,
                ],
                { back: this.#showBrowse },
              );
              return;
            }
          } else {
            downloadVaultFile(
              new Blob([result.data], {
                type: chosen === "csv" ? "text/csv" : "application/json",
              }),
              chosen === "csv" ? "orumai-vault.csv" : "orumai-vault.json",
            );
          }
          this.#showBrowse("Vault export downloaded.");
        },
        () => {
          submit.disabled = false;
          submit.textContent = "Download export";
          error.textContent = problem;
          error.hidden = false;
          master.focus();
        },
      );
    });
    this.#showPanel([create("h2", "Export your vault"), form], {
      back: this.#showBrowse,
    });
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
    const fieldset = create("fieldset");
    fieldset.className = "vault-attachment-controls";
    fieldset.append(list, picker, hint, status, error);
    return createFieldGroup("Attachments", fieldset);
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
    this.#showPanel(
      [
        create("h2", "Folders"),
        this.#toolbar(action("New folder", () => this.#folderForm())),
        ...(message ? [statusMessage(message)] : []),
        list,
      ],
      { back: this.#showBrowse },
    );
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
    this.#showPanel([create("h2", verb), form], { back });
    (deleting ? save : input).focus();
  }

  #rememberItem(vault: UnlockedVault, entry: ListedItem) {
    vault.entries = vault.entries.filter(
      ({ item }) => item.id !== entry.item.id,
    );
    vault.entries.push(entry);
  }

  #changeLifecycle(
    entry: ListedItem,
    details: ItemDetails | null,
    rowFocus?: readonly string[],
  ) {
    const vault = this.#vault;
    if (!vault) return;
    const restoring = entry.trashed;
    this.#showPanel([
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
          failure = "Sign in to Orumai to update this item.";
        if (response.status === 409 || response.status === 404)
          failure =
            "This item changed. Reload the page and unlock your vault again.";
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
          undefined,
          rowFocus,
        );
      },
      () =>
        rowFocus
          ? this.#showItems(this.#viewFor(entry), undefined, failure, rowFocus)
          : this.#showDetails(entry, details, failure),
      { blockNavigation: true },
    );
  }

  #showDetailedForm(type: ItemType, edit?: EditTarget) {
    const editor = vaultItemEditor(
      type,
      edit?.details.properties ?? {},
      Boolean(edit?.entry.item.details.credentials?.fido2Credentials?.length),
    );
    this.#showItemForm(
      type,
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
    type: ItemType,
    encrypt: (title: string, key: VaultKey, previous?: Item) => Promise<object>,
    edit: EditTarget | undefined,
    properties: HTMLElement,
  ) {
    const vault = this.#vault;
    if (!vault) return;
    const label = itemTypes[type].label;
    this.#stopWork();
    const form = create("form");
    form.className = "vault-item-form";
    form.method = "post";
    form.autocomplete = "off";
    const title = create("input");
    title.required = true;
    title.value = edit?.title ?? "";
    const { element: folderField, select: folder } = this.#folderSelect(
      vault,
      edit?.entry.item.folderId ?? "",
    );
    let editingEntry = edit?.entry;
    let conflict = false;
    const item =
      label === "Login" ? "login" : label === "Secure Note" ? "note" : "item";
    const conflictMessage = `This ${item} changed since you opened it. Your draft is still here. Cancel to load the latest version.`;
    const saveLabel = "Save";
    const save = create("button", saveLabel);
    save.type = "submit";
    save.dataset.slot = "button";
    save.className = buttonClassName({ variant: "primary", size: "sm" });
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
    };
    const showError = (message: string) => {
      setBusy();
      error.textContent = message;
      error.hidden = false;
    };
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
      createFieldGroup(
        "Item details",
        vaultField({ label: "Title", value: title }).element,
        folderField,
      ),
      properties,
    );
    if (edit) {
      form.append(
        this.#editAttachments(edit, vault, (latest, canKeepEditing) => {
          if (canKeepEditing && latest) {
            if (editingEntry?.item.revision !== latest.item.revision)
              sealed = undefined;
            editingEntry = latest;
            return;
          }
          conflict = true;
          showError(conflictMessage);
        }),
      );
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
            failure = `Sign in to Orumai to save your ${item}.`;
          if (edit && (response.status === 409 || response.status === 404)) {
            failure = conflictMessage;
            if (!signal.aborted) conflict = true;
          } else if (response.status === 409)
            failure =
              "Your vault changed. Reload the page and unlock it before saving again.";
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
    const cancelEdit = () => {
      if (this.#busy) return;
      if (!edit || !editingEntry) {
        form.reset();
        this.#showBrowse();
        return;
      }
      if (!conflict) {
        form.reset();
        this.#showDetails(editingEntry, edit.details);
        return;
      }

      const { id, type } = edit.entry.item;
      cancel.textContent = "Reloading…";
      error.hidden = true;
      void this.#run(
        async (signal) => {
          const snapshot = await this.#readSnapshot(vault, signal);
          const active = snapshot.items.find((item) => item.id === id);
          const latest =
            active ?? snapshot.trash.find((item) => item.id === id);
          return latest?.type === type
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
            vault.entries = vault.entries.filter(({ item }) => item.id !== id);
            this.#showBrowse(`This ${item} is no longer in your vault.`);
          }
        },
        () => {
          form.reset();
          this.#showItems(
            this.#view,
            undefined,
            `Could not load the latest version of this ${item}. Reload your vault to try again.`,
          );
        },
        { blockNavigation: true },
      );
    };
    const cancel = action("Cancel", cancelEdit);
    const summary = itemSummary(
      edit?.title ?? `New ${label}`,
      type,
      edit?.entry.iconHost,
      [cancel, save],
      companyForHostname(vault.companies, edit?.entry.iconHost),
    );
    form.prepend(summary.element, error);
    this.#showPanel([form], { back: cancelEdit, editing: true });
    title.focus();
  }

  #open(
    entry: ListedItem,
    { error, edit = false }: { error?: string; edit?: boolean } = {},
  ) {
    const vault = this.#vault;
    if (!vault) return;
    this.#stopWork();
    this.#selectItem(entry.item.id);
    const title = entry.title;
    if (title === null) {
      this.#showDetails(entry, null, "Could not read this item.");
      return;
    }
    const show = (password?: string) => {
      const status = create("p", "Opening item…");
      status.setAttribute("role", "status");
      this.#showPanel([status], { back: this.#showBrowse });
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
        (details) => {
          if (edit)
            this.#showDetailedForm(entry.item.type, { entry, title, details });
          else this.#showDetails(entry, details);
        },
        () => this.#open(entry, { error: failure, edit }),
      );
    };
    if (entry.item.requiresMasterPassword) {
      this.#showPanel(
        [
          create("h2", title),
          passwordForm("Open protected item", show).form,
          ...(error ? [alert(error)] : []),
        ],
        { back: this.#showBrowse },
      );
      this.#workspace?.detail.querySelector("input")?.focus();
    } else if (error) {
      this.#showDetails(entry, null, error);
    } else {
      show();
    }
  }

  #itemDetailSections(
    item: Item,
    details: ItemDetails | null,
    folderTitle: string | undefined,
  ) {
    const content = create("div");
    content.className = "vault-item-sections";
    const addFields = (label: string, rows: readonly DetailRow[]) => {
      if (rows.length)
        content.append(createFieldGroup(label, ...detailFields(rows)));
    };
    const metadata: DetailRow[] = [];
    if (folderTitle !== undefined)
      metadata.push({ label: "Folder", value: folderTitle });
    if (details?.properties.favorite)
      metadata.push({ label: "Favourite", value: "Yes", copyable: false });
    if (details?.properties.reprompt === 1)
      metadata.push({
        label: "Master password reprompt",
        value: "Required",
        copyable: false,
      });
    addFields("Item details", metadata);
    if (!details) return content;
    const { properties, key } = details;

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
          actionLabel: "password",
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
                  href: match === 4 ? undefined : webLinkHref(uri),
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
      content.append(
        createFieldGroup(
          "Notes",
          vaultField({
            label: "Notes",
            value: properties.notes,
            showLabel: false,
          }).element,
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
                  showLabel: false,
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
      content.append(createFieldGroup("Password history", output));
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
      content.append(createFieldGroup("Attachments", body));
    }
    return content.childElementCount
      ? content
      : create("p", "This item has no details.");
  }

  #showDetails(entry: ListedItem, details: ItemDetails | null, error?: string) {
    const { item, title, trashed, iconHost } = entry;
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
    if (edit)
      edit.className = buttonClassName({ variant: "primary", size: "sm" });
    const { element: summary, title: titleNode } = itemSummary(
      title ?? "Unreadable item",
      item.type,
      iconHost,
      trashed
        ? [remove, archiveOrPurge]
        : [...(edit ? [edit] : []), archiveOrPurge, remove],
      companyForHostname(this.#vault?.companies ?? [], iconHost),
    );
    const folder = this.#vault?.folders.find(
      ({ folder }) => folder.id === item.folderId,
    );
    this.#showPanel(
      [
        summary,
        ...(error ? [alert(error)] : []),
        ...(details || folder
          ? [this.#itemDetailSections(item, details, folder?.title)]
          : []),
      ],
      { back: this.#showBrowse },
    );
    if (this.#workspace?.detail === document.activeElement) titleNode.focus();
  }
}

customElements.define(vaultReader.tag, VaultReader);
