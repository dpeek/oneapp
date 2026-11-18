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
type Folder = typeof VaultFolder.Type;
type ListedFolder = { folder: Folder; title: string };
type BulkAction = (typeof VaultBulkChange.Type)["kind"];
type EditTarget = { item: Item; title: string };
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
  #folderId: string | undefined;

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
  }

  #clear() {
    this.#stopWork();
    this.#vault = null;
    this.#folderId = undefined;
    this.querySelector("form")?.reset();
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
  ) {
    this.#stopWork();
    const controller = new AbortController();
    this.#pending = controller;
    try {
      const result = await work(controller.signal);
      if (!controller.signal.aborted && this.isConnected) complete(result);
    } catch {
      if (!controller.signal.aborted && this.isConnected) failed();
    } finally {
      if (this.#pending === controller) this.#pending = null;
    }
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
          this.#showList();
        },
        () => this.#showUnlock(failure),
      );
    });
    this.replaceChildren(form, ...(error ? [alert(error)] : []));
  }

  #toolbar(back?: () => void, ...actions: (HTMLButtonElement | undefined)[]) {
    const toolbar = create("div");
    toolbar.className = "vault-toolbar";
    if (back)
      toolbar.append(
        action(
          back === this.#showTrash
            ? "Back to Trash"
            : back === this.#showArchive
              ? "Back to Archive"
              : "Back to items",
          back,
        ),
      );
    for (const button of actions) if (button) toolbar.append(button);
    toolbar.append(action("Lock vault", this.#lock));
    return toolbar;
  }

  #showList = (message?: string) => this.#showItems("active", message);
  #showArchive = (message?: string) => this.#showItems("archive", message);
  #showTrash = (message?: string) => this.#showItems("trash", message);

  #viewFor(entry: ListedItem): VaultView {
    return entry.trashed
      ? "trash"
      : entry.item.archivedAt !== null
        ? "archive"
        : "active";
  }

  #backFor(entry: ListedItem) {
    return entry.trashed
      ? this.#showTrash
      : entry.item.archivedAt !== null
        ? this.#showArchive
        : this.#showList;
  }

  #folderOptions(all: boolean) {
    const select = create("select");
    if (all) select.add(new Option("All folders", "*"));
    select.add(new Option("No folder", ""));
    for (const { folder, title } of this.#vault?.folders ?? [])
      select.add(new Option(title, folder.id));
    return select;
  }

  #showItems(view: VaultView, message?: string, problem?: string) {
    this.#stopWork();
    const vault = this.#vault;
    if (!vault) return;
    const toolbar =
      view === "active"
        ? this.#toolbar(
            undefined,
            action("New Login", () => this.#showLoginForm()),
            action("New Secure Note", () => this.#showNoteForm()),
            action("Other item types", () => this.#showItemTypes()),
            action("Folders", () => this.#showFolders()),
            action("Import", () => this.#showImport()),
            action("Export", () => this.#showExport()),
            action("Archive", this.#showArchive),
            action("Trash", this.#showTrash),
          )
        : this.#toolbar(this.#showList);
    const list = create("ul");
    list.className = "vault-items";
    const filter = this.#folderOptions(true);
    filter.value = this.#folderId ?? "*";
    filter.addEventListener("change", () => {
      this.#folderId = filter.value === "*" ? undefined : filter.value;
      this.#showItems(view);
    });
    const folderFilter = create("label", "Folder ");
    folderFilter.append(filter);
    const entries = vault.entries
      .filter((entry) => this.#viewFor(entry) === view)
      .filter(
        ({ item }) =>
          view !== "active" ||
          this.#folderId === undefined ||
          (item.folderId ?? "") === this.#folderId,
      )
      .sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
    const selected = new Set<ListedItem>();
    const bulk = create("div");
    bulk.className = "vault-toolbar";
    const buttons: HTMLButtonElement[] = [];
    const operation = (label: string, kind: BulkAction) => {
      const button = action(label, () =>
        this.#startBulk(view, [...selected], kind),
      );
      button.disabled = true;
      buttons.push(button);
      return button;
    };
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
        for (const button of buttons) button.disabled = selected.size === 0;
      });
      row.append(
        select,
        action(entry.title ?? "Unreadable item", () => this.#open(entry)),
        create("span", itemTypes[entry.item.type].label),
      );
      list.append(row);
    }
    this.replaceChildren(
      toolbar,
      ...(view === "trash"
        ? [create("h3", "Trash")]
        : view === "archive"
          ? [create("h3", "Archive")]
          : [folderFilter]),
      ...(message ? [statusMessage(message)] : []),
      ...(problem
        ? [
            alert(problem),
            action("Reload vault", () =>
              this.#refresh(() => this.#showItems(view)),
            ),
          ]
        : []),
      ...(list.childElementCount
        ? [bulk, list]
        : [create("p", "No items in this view.")]),
    );
    toolbar.querySelector("button")?.focus();
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
        this.append(
          alert("Could not reload your vault. Lock and unlock to try again."),
        ),
    );
  }

  #startBulk(view: VaultView, entries: ListedItem[], kind: BulkAction) {
    const folder = this.#folderOptions(false);
    const execute = () =>
      this.#applyBulk(view, entries, kind, folder.value || null);
    if (kind === "move") {
      if (entries.length === 1) folder.value = entries[0]!.item.folderId ?? "";
      this.replaceChildren(
        this.#toolbar(() => this.#showItems(view)),
        create("h3", "Move to folder"),
        folder,
        action("Move items", execute),
      );
      folder.setAttribute("aria-label", "Destination folder");
      folder.focus();
    } else if (kind === "purge") {
      this.replaceChildren(
        this.#toolbar(() => this.#showItems(view)),
        create("h3", "Permanently delete items?"),
        create(
          "p",
          `Delete ${entries.length} selected item(s) permanently. This cannot be undone.`,
        ),
        action("Permanently delete", execute),
        action("Cancel", () => this.#showItems(view)),
      );
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
    this.replaceChildren(this.#toolbar(), statusMessage("Updating items…"));
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
    this.replaceChildren(
      this.#toolbar(this.#showList),
      create("h3", "Import into your vault"),
      form,
    );
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
          this.#folderId = undefined;
          this.#showList(
            `Imported ${prepared.items} item(s) and ${prepared.folders} folder(s).`,
          );
        },
        () => {
          submit.disabled = false;
          error.textContent = failure;
          error.hidden = false;
        },
      );
    });
    this.replaceChildren(
      this.#toolbar(() => this.#showImport()),
      create("h3", "Review import"),
      create(
        "p",
        `Import ${prepared.items} item(s) and ${prepared.folders} folder(s). Importing the same file again creates copies.`,
      ),
      submit,
      error,
    );
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
          ? "Download plaintext. CSV includes logins and Secure Notes with limited fields."
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
          const portable = await openPortableVault(snapshot, key, signal);
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
              this.replaceChildren(
                this.#toolbar(this.#showList),
                alert(
                  `The ZIP contains ${result.count} attachment(s). ${result.failed.length} could not be included.`,
                ),
                missing,
              );
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
          this.#showList("Vault export downloaded.");
        },
        () => {
          submit.disabled = false;
          error.textContent = problem;
          error.hidden = false;
          master.focus();
        },
      );
    });
    this.replaceChildren(
      this.#toolbar(this.#showList),
      create("h3", "Export your vault"),
      form,
    );
    format.focus();
  }

  #showAttachments(entry: ListedItem, key: VaultKey, message?: string) {
    this.#stopWork();
    const vault = this.#vault;
    if (!vault) return;
    const item = entry.item;
    const back = () => this.#open(entry);
    const heading = create("h3", `Attachments for ${entry.title ?? "item"}`);
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
    this.replaceChildren(
      this.#toolbar(back),
      heading,
      ...(message ? [statusMessage(message)] : []),
      status,
      item.attachments.length ? list : create("p", "No attachments."),
      ...(entry.trashed ? [] : [form]),
    );
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
        if (latest && latest.item.wrappedKey === entry.item.wrappedKey)
          this.#showAttachments(latest, key, message);
        else this.#showList(message);
      },
      () => failed(problem),
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
    this.replaceChildren(
      this.#toolbar(
        this.#showList,
        action("New folder", () => this.#folderForm()),
      ),
      create("h3", "Folders"),
      ...(message ? [statusMessage(message)] : []),
      list,
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
          if (deleting && this.#folderId === entry?.folder.id)
            this.#folderId = undefined;
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
      );
    });
    form.append(
      deleting
        ? create("p", `Items in ${entry?.title} will move to No folder.`)
        : itemField(["Folder name", input]),
      save,
      status,
    );
    this.replaceChildren(this.#toolbar(back), create("h3", verb), form);
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
    this.replaceChildren(
      this.#toolbar(),
      statusMessage(restoring ? "Restoring item…" : "Moving item to Trash…"),
    );
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
    for (const type of extraItemTypes) {
      const row = create("li");
      row.append(
        action(itemTypes[type].label, () => this.#showDetailedForm(type)),
      );
      choices.append(row);
    }
    this.replaceChildren(
      this.#toolbar(this.#showList),
      create("h3", "New item"),
      choices,
    );
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
              else this.#open(latest);
            } else {
              vault.entries = vault.entries.filter(
                ({ item }) => item.id !== edit.item.id,
              );
              this.#showList(`This ${item} is no longer in your vault.`);
            }
          },
          () => showError(failure),
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
          this.#open(entry);
        },
        () => showError(failure),
      );
    });
    this.replaceChildren(
      this.#toolbar(() => {
        form.reset();
        this.#showList();
      }),
      create("h3", `${edit ? "Edit" : "New"} ${label}`),
      form,
    );
    title.focus();
  }

  #open(entry: ListedItem, error?: string) {
    const vault = this.#vault;
    if (!vault) return;
    if (entry.title === null) {
      this.#showDetails(entry, null, "Could not read this item.");
      return;
    }
    const back = this.#backFor(entry);
    const show = (password?: string) => {
      const status = create("p", "Opening item…");
      status.setAttribute("role", "status");
      this.replaceChildren(this.#toolbar(back), status);
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
      this.replaceChildren(
        this.#toolbar(back),
        create("h3", entry.title),
        passwordForm("Open protected item", show),
        ...(error ? [alert(error)] : []),
      );
      this.querySelector("input")?.focus();
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
    const titleNode = create("h3", title ?? "Unreadable item");
    titleNode.tabIndex = -1;
    let edit: HTMLButtonElement | undefined;
    if (!trashed && title !== null && details) {
      if (item.type === 2)
        edit = action("Edit Secure Note", () =>
          this.#showNoteForm({ item, title, notes: details.notes }),
        );
      else if (item.type === 1 && login)
        edit = action("Edit Login", () =>
          this.#showLoginForm({ item, title, login }),
        );
      else
        edit = action(`Edit ${itemTypes[item.type].label}`, () =>
          this.#showDetailedForm(item.type, { item, title, details }),
        );
    }
    this.replaceChildren(
      this.#toolbar(
        this.#backFor(entry),
        edit,
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
              this.#showDetailedForm(item.type, { item, title, details }),
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
      ),
      titleNode,
      ...(error ? [alert(error)] : []),
      ...(details
        ? [
            fields.childElementCount
              ? fields
              : create("p", "This item has no details."),
          ]
        : []),
    );
    titleNode.focus();
  }
}

customElements.define(vaultReader.tag, VaultReader);
