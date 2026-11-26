import {
  buttonClassName,
  createField,
  createFieldGroup,
  createNativeSelect,
  trashIconPaths,
} from "@orumai/ui";
import type { EditableItemDetails, ItemType } from "./vault-item-content.ts";
import { vaultField } from "./vault-field.ts";
import { vaultIcon } from "./vault-item-icon.ts";
import { hostUriMatch } from "./vault-items-contract.ts";
import { identityEditGroups } from "./vault-identity-layout.ts";
import {
  structuredEditGroup,
  type VaultFieldPresentation,
} from "./vault-item-layout.ts";
import {
  encryptOptionalText,
  encryptWebsite,
  type VaultKey,
} from "./vault-crypto.ts";

type Details = typeof EditableItemDetails.Type;

const uriMatchLabels = [
  "Base domain",
  "Host",
  "Starts with",
  "Exact",
  "Regular expression",
  "Never",
] as const;
const customFieldLabels = ["Text", "Hidden", "Boolean", "Linked"] as const;

const linkedFields: Partial<
  Record<ItemType, Readonly<Record<number, string>>>
> = {
  1: { 100: "Username", 101: "Password" },
  3: {
    300: "Cardholder name",
    301: "Expiry month",
    302: "Expiry year",
    303: "Security code",
    304: "Brand",
    305: "Card number",
  },
  4: {
    400: "Title or honorific",
    401: "Middle name",
    402: "Address line 1",
    403: "Address line 2",
    404: "Address line 3",
    405: "City",
    406: "State or province",
    407: "Postal code",
    408: "Country",
    409: "Company",
    410: "Email",
    411: "Phone",
    412: "Social security number",
    413: "Username",
    414: "Passport number",
    415: "License number",
    416: "First name",
    417: "Last name",
    418: "Full name",
  },
};
export const linkedFieldLabel = (type: ItemType, id: number) =>
  linkedFields[type]?.[id] ?? `Field ${id}`;

const checkboxField = (label: string, control: HTMLInputElement) => {
  const element = createField({ label, content: control, control });
  element.classList.add("vault-item-checkbox");
  return element;
};

const input = (value: string | null | undefined, type = "text") => {
  const el = document.createElement("input");
  el.type = type;
  el.autocomplete = type === "password" ? "new-password" : "off";
  el.spellcheck = false;
  el.value = value ?? "";
  return el;
};

const builtInInputs = (
  element: HTMLElement,
  type: ItemType,
  data: Details["data"],
) => {
  if (type === 1 || type === 2) return [];
  const groups = type === 4 ? identityEditGroups : [structuredEditGroup(type)];
  return groups.flatMap(({ label, fields }) => {
    const section = createFieldGroup(label);
    element.append(section);
    return fields.map(
      ({
        name,
        label,
        visibility,
        inputMode,
        multiline,
        date,
      }: VaultFieldPresentation & { name: string; label: string }) => {
        const control = multiline
          ? document.createElement("textarea")
          : input(data?.[name], visibility === "masked" ? "password" : "text");
        if (control instanceof HTMLTextAreaElement) {
          control.value = data?.[name] ?? "";
          control.rows = 4;
        }
        if (inputMode) control.inputMode = inputMode;
        if (date) control.placeholder = "YYYY-MM-DD";
        section.append(
          vaultField({ label, value: control, masked: visibility === "masked" })
            .element,
        );
        return [name, control] as const;
      },
    );
  });
};

const websiteAddress = (value: string, match: string) => {
  const address = value.trim();
  if (match === "4" || !/^https?:/iu.test(address)) return address;
  return /^https?:\/\//iu.test(address)
    ? (URL.parse(address)?.href ?? null)
    : null;
};

const choice = (
  label: string,
  values: readonly string[],
  selected: number | null | undefined,
  defaultLabel?: string,
) =>
  createNativeSelect({
    label,
    options: [
      ...(defaultLabel ? [{ label: defaultLabel, value: "" }] : []),
      ...values.map((label, index) => ({ label, value: String(index) })),
    ],
    value: selected == null ? (defaultLabel ? "" : "0") : String(selected),
  });

const rows = <Value, Row extends { element: HTMLElement }>(
  caption: string,
  addLabel: string,
  initial: readonly (Value | undefined)[],
  makeRow: (value?: Value) => Row,
  removeIcon?: { label: string; paths: readonly string[] },
) => {
  const element = createFieldGroup(caption);
  const add = document.createElement("button");
  add.type = "button";
  add.dataset.slot = "button";
  add.className = buttonClassName({ variant: "outline", size: "sm" });
  add.textContent = addLabel;
  const contents: Row[] = [];
  const changed = () =>
    element.dispatchEvent(new Event("input", { bubbles: true }));
  const append = (value?: Value) => {
    const row = makeRow(value);
    row.element.classList.add("vault-item-repeat-row");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.slot = "button";
    remove.className = buttonClassName({
      variant: "ghost",
      size: removeIcon ? "icon-sm" : "sm",
    });
    if (removeIcon) {
      const icon = vaultIcon(removeIcon.paths);
      icon.setAttribute("width", "16");
      icon.setAttribute("height", "16");
      remove.setAttribute("aria-label", removeIcon.label);
      remove.title = removeIcon.label;
      remove.append(icon);
    } else remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      contents.splice(contents.indexOf(row), 1);
      row.element.remove();
      changed();
    });
    row.element.append(remove);
    contents.push(row);
    element.insertBefore(row.element, add);
  };
  add.addEventListener("click", () => {
    append();
    changed();
  });
  element.append(add);
  initial.forEach(append);
  return { element, contents };
};

export const vaultItemEditor = (
  type: ItemType,
  initial: Details,
  hasPasskey: boolean,
) => {
  const element = document.createElement("div");
  element.className = "vault-item-editor";
  const notes = document.createElement("textarea");
  notes.rows = 5;
  notes.value = initial.notes ?? "";
  const favorite = input(undefined, "checkbox");
  favorite.checked = initial.favorite === true;
  const reprompt = input(undefined, "checkbox");
  reprompt.checked = initial.reprompt === 1;

  const data = builtInInputs(element, type, initial.data);
  const login = initial.credentials;
  const username = input(login?.username);
  const password = input(login?.password, "password");
  const totp = input(login?.totp, "password");
  const websites = rows(
    "Autofill options",
    "Add website",
    login?.uris?.length ? login.uris : [undefined],
    (value) => {
      const element = document.createElement("div");
      element.className = "vault-website-row";
      const uri = input(value?.uri);
      uri.inputMode = "url";
      uri.placeholder = "https://example.com";
      const { element: matchField, select: match } = choice(
        "URI match",
        uriMatchLabels,
        value ? value.match : hostUriMatch,
        "Default",
      );
      const validate = () =>
        uri.setCustomValidity(
          uri.value === (value?.uri ?? "") ||
            websiteAddress(uri.value, match.value) !== null
            ? ""
            : "Enter an HTTP or HTTPS website address.",
        );
      uri.addEventListener("input", validate);
      match.addEventListener("change", validate);
      element.append(
        vaultField({ label: "Website", value: uri }).element,
        matchField,
      );
      return { element, uri, match, previous: value };
    },
    { label: "Remove website", paths: trashIconPaths },
  );
  if (type === 1) {
    const credentials = createFieldGroup(
      "Login credentials",
      vaultField({ label: "Username", value: username }).element,
      vaultField({ label: "Password", value: password, masked: true }).element,
      vaultField({ label: "TOTP seed", value: totp, masked: true }).element,
    );
    if (hasPasskey) {
      const passkey = document.createElement("p");
      passkey.textContent = "Passkey saved in this login.";
      credentials.append(passkey);
    }
    element.append(credentials, websites.element);
  }

  const fields = rows(
    "Custom fields",
    "Add custom field",
    initial.fields ?? [],
    (previous) => {
      const element = document.createElement("div");
      const name = input(previous?.name);
      const value = input(previous?.value, "password");
      const supported = linkedFields[type];
      const linkedOptions = [
        { label: "Choose a field", value: "" },
        ...Object.entries(supported ?? {}).map(([value, label]) => ({
          label,
          value,
        })),
      ];
      const previousId = previous?.linkedId;
      if (previousId != null && !supported?.[previousId])
        linkedOptions.push({
          label: linkedFieldLabel(type, previousId),
          value: String(previousId),
        });
      const { element: linkedField, select: linked } = createNativeSelect({
        label: "Linked field",
        options: linkedOptions,
        value: previousId?.toString() ?? "",
      });
      const boolean = input(undefined, "checkbox");
      boolean.checked = previous?.value === "true";
      const { element: kindField, select: kind } = choice(
        "Field type",
        customFieldLabels,
        previous?.type,
      );
      if (!supported && previous?.type !== 3) kind.options[3]!.disabled = true;
      const valueField = vaultField({ label: "Field value", value });
      const booleanField = checkboxField("True", boolean);
      const showValue = () => {
        valueField.element.hidden = kind.value === "2" || kind.value === "3";
        booleanField.hidden = kind.value !== "2";
        linkedField.hidden = kind.value !== "3";
        valueField.setMaskable(kind.value === "1");
      };
      kind.addEventListener("change", showValue);
      showValue();
      element.append(
        vaultField({ label: "Field name", value: name }).element,
        kindField,
        valueField.element,
        booleanField,
        linkedField,
      );
      return { element, name, kind, value, linked, boolean, previous };
    },
  );
  const favoriteField = checkboxField("Favourite", favorite);
  const repromptField = checkboxField("Require master password", reprompt);
  element.append(
    createFieldGroup(
      "Notes",
      vaultField({
        label: type === 2 ? "Note" : "Notes",
        value: notes,
        showLabel: false,
      }).element,
    ),
    createFieldGroup("Item options", favoriteField, repromptField),
    fields.element,
  );
  return {
    element,
    async encrypt(key: VaultKey, previous?: Details): Promise<Details> {
      const seal = (
        value: string,
        plaintext: string | null | undefined,
        ciphertext: string | null | undefined,
      ) =>
        value === (plaintext ?? "")
          ? Promise.resolve(ciphertext ?? null)
          : encryptOptionalText(value, key);
      return {
        notes: await seal(notes.value, initial.notes, previous?.notes),
        favorite: favorite.checked,
        reprompt: reprompt.checked ? 1 : 0,
        fields: await Promise.all(
          fields.contents.map(async (row) => {
            const type = Number(row.kind.value) as 0 | 1 | 2 | 3;
            const linkedId =
              type === 3 && row.linked.value !== ""
                ? Number(row.linked.value)
                : null;
            const index = row.previous
              ? (initial.fields?.indexOf(row.previous) ?? -1)
              : -1;
            const existing = previous?.fields?.[index];
            const value =
              type === 2 ? String(row.boolean.checked) : row.value.value;
            if (
              existing &&
              type === row.previous?.type &&
              (row.previous.linkedId ?? null) === linkedId &&
              (type === 3 ||
                (row.previous.value ?? "") === value ||
                (type === 2 &&
                  row.previous.value == null &&
                  value === "false")) &&
              (row.previous.name ?? "") === row.name.value
            )
              return existing;
            return {
              type,
              name: await encryptOptionalText(row.name.value, key),
              value: type === 3 ? null : await encryptOptionalText(value, key),
              linkedId,
            };
          }),
        ),
        ...(type === 1 && {
          credentials: {
            username: await seal(
              username.value,
              login?.username,
              previous?.credentials?.username,
            ),
            password: await seal(
              password.value,
              login?.password,
              previous?.credentials?.password,
            ),
            totp: await seal(
              totp.value,
              login?.totp,
              previous?.credentials?.totp,
            ),
            uris: await Promise.all(
              websites.contents
                .filter(
                  ({ uri, previous }) =>
                    uri.value.trim() ||
                    (previous && uri.value === (previous.uri ?? "")),
                )
                .map(async (row) => {
                  const match =
                    row.match.value === ""
                      ? null
                      : (Number(row.match.value) as 0 | 1 | 2 | 3 | 4 | 5);
                  const index = row.previous
                    ? (login?.uris?.indexOf(row.previous) ?? -1)
                    : -1;
                  const existing = previous?.credentials?.uris?.[index];
                  if (existing && (row.previous?.uri ?? "") === row.uri.value)
                    return (row.previous?.match ?? null) === match
                      ? existing
                      : { ...existing, match };
                  const address = websiteAddress(
                    row.uri.value,
                    row.match.value,
                  );
                  if (address === null)
                    throw new Error("Invalid website address");
                  return {
                    ...(address
                      ? await encryptWebsite(address, key)
                      : { uri: null, uriChecksum: null }),
                    match,
                  };
                }),
            ),
          },
        }),
        ...(data.length > 0 && {
          data: Object.fromEntries(
            await Promise.all(
              data
                // Preserve omitted optional fields from imported items.
                .filter(
                  ([name, value]) =>
                    value.value !== "" ||
                    Object.hasOwn(previous?.data ?? {}, name),
                )
                .map(async ([name, value]) => [
                  name,
                  await seal(
                    value.value,
                    initial.data?.[name],
                    previous?.data?.[name],
                  ),
                ]),
            ),
          ),
        }),
      };
    },
  };
};
