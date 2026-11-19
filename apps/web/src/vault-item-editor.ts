import type {
  EditableItemDetails,
  ItemDetails,
  ItemType,
} from "./vault-item-content.ts";
import { itemTypes } from "./vault-item-content.ts";
import { identityEditGroups } from "./vault-identity-layout.ts";
import {
  decryptVaultText,
  encryptOptionalText,
  encryptWebsite,
  type VaultKey,
} from "./vault-crypto.ts";

type Details = typeof EditableItemDetails.Type;

const mapText = async (
  values: Readonly<Record<string, string | null>>,
  transform: (value: string) => Promise<string | null>,
) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(values).map(async ([name, value]) => [
        name,
        value === null ? null : await transform(value),
      ]),
    ),
  );

export const decryptItemDetails = async (
  details: typeof ItemDetails.Type,
  key: VaultKey,
): Promise<Details> => {
  const read = (value: string | null | undefined) =>
    value == null ? Promise.resolve(null) : decryptVaultText(value, key);
  const credentials = details.credentials;
  return {
    ...details,
    notes: await read(details.notes),
    fields: await Promise.all(
      (details.fields ?? []).map(async (field) => ({
        ...field,
        name: await read(field.name),
        value: await read(field.value),
      })),
    ),
    ...(credentials && {
      credentials: {
        autofillOnPageLoad: credentials.autofillOnPageLoad,
        passwordRevisionDate: credentials.passwordRevisionDate,
        username: await read(credentials.username),
        password: await read(credentials.password),
        totp: await read(credentials.totp),
        uris: await Promise.all(
          (credentials.uris ?? []).map(async ({ uri, match }) => ({
            uri: await read(uri),
            match,
          })),
        ),
      },
    }),
    ...(details.data && {
      data: await mapText(details.data, (value) =>
        decryptVaultText(value, key),
      ),
    }),
  };
};

export const uriMatchLabels = [
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

const field = (caption: string, input: HTMLElement) => {
  const label = document.createElement("label");
  label.className = "vault-item-field";
  label.textContent = caption;
  label.append(input);
  return label;
};

const input = (value: string | null | undefined, type = "text") => {
  const el = document.createElement("input");
  el.type = type;
  el.autocomplete = type === "password" ? "new-password" : "off";
  el.spellcheck = false;
  el.value = value ?? "";
  return el;
};

const identityInputs = (element: HTMLElement, data: Details["data"]) =>
  identityEditGroups.flatMap((group) => {
    const section = document.createElement("fieldset");
    section.className = "vault-identity-edit-group";
    const heading = document.createElement("legend");
    heading.textContent = group.label;
    section.append(heading);
    element.append(section);
    return group.fields.map(({ name, label, visibility, inputMode }) => {
      const control = input(
        data?.[name],
        visibility === "masked" ? "password" : "text",
      );
      control.autocomplete = "off";
      if (inputMode) control.inputMode = inputMode;
      const labelled = field(label, control);
      if (visibility === "masked") {
        const row = document.createElement("div");
        row.className = "vault-identity-input";
        const toggle = document.createElement("button");
        toggle.type = "button";
        const update = () => {
          const verb = control.type === "password" ? "Show" : "Hide";
          toggle.textContent = verb;
          toggle.setAttribute("aria-label", `${verb} ${label}`);
        };
        toggle.addEventListener("click", () => {
          control.type = control.type === "password" ? "text" : "password";
          update();
        });
        update();
        row.append(labelled, toggle);
        section.append(row);
      } else section.append(labelled);
      return [name, control] as const;
    });
  });

const choice = (
  values: readonly string[],
  selected: number | null | undefined,
  defaultLabel?: string,
) => {
  const el = document.createElement("select");
  if (defaultLabel) el.add(new Option(defaultLabel, ""));
  values.forEach((label, index) => el.add(new Option(label, String(index))));
  el.value = selected == null ? (defaultLabel ? "" : "0") : String(selected);
  return el;
};

const rows = <Value, Row extends { element: HTMLElement }>(
  caption: string,
  initial: readonly Value[],
  makeRow: (value?: Value) => Row,
) => {
  const element = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = caption;
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = `Add ${caption === "Websites" ? "website" : "custom field"}`;
  const contents: Row[] = [];
  const changed = () =>
    element.dispatchEvent(new Event("input", { bubbles: true }));
  const append = (value?: Value) => {
    const row = makeRow(value);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
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
  element.append(legend, add);
  initial.forEach(append);
  return { element, contents };
};

export const vaultItemEditor = (type: ItemType, initial: Details) => {
  const element = document.createElement("div");
  const notes = document.createElement("textarea");
  notes.rows = 5;
  notes.value = initial.notes ?? "";
  const favorite = input(undefined, "checkbox");
  favorite.checked = initial.favorite === true;
  const reprompt = input(undefined, "checkbox");
  reprompt.checked = initial.reprompt === 1;

  const data =
    type === 4
      ? identityInputs(element, initial.data)
      : Object.entries(itemTypes[type].fields).map(([name, label]) => {
          if (type === 5) {
            const value = document.createElement("textarea");
            value.value = initial.data?.[name] ?? "";
            value.rows = 4;
            if (name === "privateKey") {
              const disclosure = document.createElement("details");
              const summary = document.createElement("summary");
              summary.textContent = "Show or edit private key";
              disclosure.append(summary, field(label, value));
              element.append(disclosure);
            } else element.append(field(label, value));
            return [name, value] as const;
          }
          const value = input(initial.data?.[name], "password");
          element.append(field(label, value));
          return [name, value] as const;
        });

  const login = initial.credentials;
  const username = input(login?.username);
  const password = input(login?.password, "password");
  const totp = input(login?.totp, "password");
  const websites = rows("Websites", login?.uris ?? [], (value) => {
    const element = document.createElement("div");
    const uri = input(value?.uri);
    const match = choice(uriMatchLabels, value?.match, "Default");
    element.append(field("Website", uri), field("URI match", match));
    return { element, uri, match, previous: value };
  });
  if (type === 1)
    element.append(
      field("Username", username),
      field("Password", password),
      field("TOTP seed", totp),
      websites.element,
    );

  const fields = rows("Custom fields", initial.fields ?? [], (previous) => {
    const element = document.createElement("div");
    const name = input(previous?.name);
    const value = input(previous?.value, "password");
    const linked = document.createElement("select");
    linked.add(new Option("Choose a field", ""));
    const supported = linkedFields[type];
    for (const [id, label] of Object.entries(supported ?? {}))
      linked.add(new Option(label, id));
    const previousId = previous?.linkedId;
    if (previousId != null && !supported?.[previousId])
      linked.add(
        new Option(linkedFieldLabel(type, previousId), String(previousId)),
      );
    linked.value = previousId?.toString() ?? "";
    const boolean = input(undefined, "checkbox");
    boolean.checked = previous?.value === "true";
    const kind = choice(customFieldLabels, previous?.type);
    if (!supported && previous?.type !== 3) kind.options[3]!.disabled = true;
    const valueField = field("Field value", value);
    const booleanField = field("True", boolean);
    const linkedField = field("Linked field", linked);
    const showValue = () => {
      valueField.hidden = kind.value === "2" || kind.value === "3";
      booleanField.hidden = kind.value !== "2";
      linkedField.hidden = kind.value !== "3";
      value.type = kind.value === "1" ? "password" : "text";
    };
    kind.addEventListener("change", showValue);
    showValue();
    element.append(
      field("Field name", name),
      field("Field type", kind),
      valueField,
      booleanField,
      linkedField,
    );
    return { element, name, kind, value, linked, boolean, previous };
  });
  element.append(
    field("Notes", notes),
    field("Favourite", favorite),
    field("Require master password", reprompt),
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
              websites.contents.map(async (row) => {
                const match =
                  row.match.value === ""
                    ? null
                    : (Number(row.match.value) as 0 | 1 | 2 | 3 | 4 | 5);
                const index = row.previous
                  ? (login?.uris?.indexOf(row.previous) ?? -1)
                  : -1;
                const existing = previous?.credentials?.uris?.[index];
                if (
                  existing &&
                  (row.previous?.uri ?? "") === row.uri.value &&
                  (row.previous?.match ?? null) === match
                )
                  return existing;
                return {
                  ...(row.uri.value
                    ? await encryptWebsite(row.uri.value, key)
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
                // Keep untouched optional Identity fields absent across import and export.
                .filter(
                  ([name, value]) =>
                    type !== 4 ||
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
