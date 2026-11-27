import {
  decryptVaultText,
  encryptNewItem,
  encryptOptionalText,
  encryptVaultText,
  encryptWebsite,
  type VaultKey,
} from "@orumai/core/vault-crypto";
import type { EditableItemDetails, ItemDetails } from "./vault-item-content.ts";

export * from "@orumai/core/vault-crypto";

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
): Promise<typeof EditableItemDetails.Type> => {
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

export const encryptNoteFields = async (
  title: string,
  note: string,
  key: VaultKey,
) => ({
  name: await encryptVaultText(title, key),
  notes: await encryptOptionalText(note, key),
});

export const encryptSecureNote = (
  title: string,
  note: string,
  userKey: VaultKey,
) => encryptNewItem(userKey, (key) => encryptNoteFields(title, note, key));

export const encryptLogin = (
  login: { title: string; username: string; password: string; website: string },
  userKey: VaultKey,
) =>
  encryptNewItem(userKey, async (key) => ({
    type: 1 as const,
    name: await encryptVaultText(login.title, key),
    username: await encryptOptionalText(login.username, key),
    password: await encryptOptionalText(login.password, key),
    website:
      login.website === "" ? null : await encryptWebsite(login.website, key),
  }));
