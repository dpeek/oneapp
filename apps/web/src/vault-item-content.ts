import { EncryptedLoginUri, EncryptedVaultValue } from "@orumai/core/vault";
import { Schema } from "effect";
export { EncryptedVaultValue, WrappedItemKey } from "@orumai/core/vault";

const Encrypted = EncryptedVaultValue;
const optionalEncrypted = Schema.optionalKey(Schema.NullOr(Encrypted));
const utcDate = Schema.String.check(
  Schema.isMaxLength(40),
  Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/u),
);
export const optionalDate = Schema.optionalKey(Schema.NullOr(utcDate));
export const PasskeyCreationDate = utcDate.check(
  Schema.makeFilter((date) => Number.isFinite(Date.parse(date))),
);

const EncryptedPasskey = Schema.Struct({
  credentialId: Encrypted,
  keyType: Encrypted,
  keyAlgorithm: Encrypted,
  keyCurve: Encrypted,
  keyValue: Encrypted,
  rpId: Encrypted,
  counter: Encrypted,
  discoverable: Encrypted,
  userHandle: optionalEncrypted,
  userName: optionalEncrypted,
  userDisplayName: optionalEncrypted,
  rpName: optionalEncrypted,
  creationDate: PasskeyCreationDate,
});
export type EncryptedPasskey = typeof EncryptedPasskey.Type;
export const PasskeyList = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(
    Schema.NullOr(Schema.Array(schema).check(Schema.isMaxLength(100))),
  );

const EditableLogin = Schema.Struct({
  username: optionalEncrypted,
  password: optionalEncrypted,
  totp: optionalEncrypted,
  passwordRevisionDate: optionalDate,
  autofillOnPageLoad: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  uris: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(EncryptedLoginUri).check(Schema.isMaxLength(100)),
    ),
  ),
});

export const LoginCredentials = Schema.Struct({
  ...EditableLogin.fields,
  fido2Credentials: PasskeyList(EncryptedPasskey),
});

export const ItemMetadata = {
  notes: optionalEncrypted,
  favorite: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  reprompt: Schema.optionalKey(Schema.NullOr(Schema.Literals([0, 1]))),
  fields: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          type: Schema.Literals([0, 1, 2, 3]),
          name: optionalEncrypted,
          value: optionalEncrypted,
          linkedId: Schema.optionalKey(
            Schema.NullOr(Schema.Number.check(Schema.isInt())),
          ),
        }),
      ).check(Schema.isMaxLength(100)),
    ),
  ),
};

export const LoginPasswordHistory = Schema.optionalKey(
  Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        lastUsedDate: optionalDate,
        password: optionalEncrypted,
      }),
    ).check(Schema.isMaxLength(100)),
  ),
);

export const ItemType = Schema.Literals([1, 2, 3, 4, 5, 6, 7, 8]);
export type ItemType = typeof ItemType.Type;

export const itemTypes = {
  1: { label: "Login", wire: "login", fields: {} },
  2: { label: "Secure Note", wire: "secureNote", fields: {} },
  3: {
    label: "Card",
    wire: "card",
    fields: {
      cardholderName: "Cardholder name",
      brand: "Brand",
      number: "Card number",
      expMonth: "Expiry month",
      expYear: "Expiry year",
      code: "Security code",
    },
  },
  4: {
    label: "Identity",
    wire: "identity",
    fields: {
      title: "Title or honorific",
      firstName: "First name",
      middleName: "Middle name",
      lastName: "Last name",
      address1: "Address line 1",
      address2: "Address line 2",
      address3: "Address line 3",
      city: "City",
      state: "State or province",
      postalCode: "Postal code",
      country: "Country",
      company: "Company",
      email: "Email",
      phone: "Phone",
      ssn: "Social security number",
      username: "Username",
      passportNumber: "Passport number",
      licenseNumber: "License number",
    },
  },
  5: {
    label: "SSH Key",
    wire: "sshKey",
    fields: {
      privateKey: "Private key",
      publicKey: "Public key",
      keyFingerprint: "Fingerprint",
    },
  },
  6: {
    label: "Bank Account",
    wire: "bankAccount",
    fields: {
      bankName: "Bank",
      nameOnAccount: "Name on account",
      accountType: "Account type",
      accountNumber: "Account number",
      routingNumber: "Routing number",
      branchNumber: "Branch number",
      pin: "PIN",
      swiftCode: "SWIFT code",
      iban: "IBAN",
      bankContactPhone: "Bank contact phone",
    },
  },
  7: {
    label: "Driver’s License",
    wire: "driversLicense",
    fields: {
      firstName: "First name",
      middleName: "Middle name",
      lastName: "Last name",
      dateOfBirth: "Date of birth",
      licenseNumber: "License number",
      issuingCountry: "Issuing country",
      issuingState: "Issuing state",
      issueDate: "Issue date",
      expirationDate: "Expiration date",
      issuingAuthority: "Issuing authority",
      licenseClass: "License class",
    },
  },
  8: {
    label: "Passport",
    wire: "passport",
    fields: {
      surname: "Surname",
      givenName: "Given name",
      dateOfBirth: "Date of birth",
      sex: "Sex",
      birthPlace: "Place of birth",
      nationality: "Nationality",
      issuingCountry: "Issuing country",
      passportNumber: "Passport number",
      passportType: "Passport type",
      nationalIdentificationNumber: "National identification number",
      issuingAuthority: "Issuing authority",
      issueDate: "Issue date",
      expirationDate: "Expiration date",
    },
  },
} as const;

export const extraItemTypes = [3, 4, 5, 6, 7, 8] as const;
export const vaultItemTypeOrder = [1, 2, ...extraItemTypes] as const;
export const ExtraItemType = Schema.Literals(extraItemTypes);

export const encryptedTypeData = (type: typeof ExtraItemType.Type) =>
  Schema.Struct(
    Object.fromEntries(
      Object.keys(itemTypes[type].fields).map((field) => [
        field,
        optionalEncrypted,
      ]),
    ),
  );

export const EditableItemDetails = Schema.Struct({
  ...ItemMetadata,
  passwordHistory: LoginPasswordHistory,
  credentials: Schema.optionalKey(EditableLogin),
  data: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.NullOr(Encrypted)),
  ),
});

export const ItemDetails = Schema.Struct({
  ...EditableItemDetails.fields,
  credentials: Schema.optionalKey(LoginCredentials),
});

export const validateDetails = (
  type: ItemType,
  details: typeof ItemDetails.Type,
) => {
  const { credentials, data } = details;
  if (type === 1) return data === undefined;
  if (credentials !== undefined || details.passwordHistory?.length)
    return false;
  if (type === 2) return data === undefined;
  return (
    data === undefined ||
    Object.keys(data).every((field) =>
      Object.hasOwn(itemTypes[type].fields, field),
    )
  );
};

export type ItemContent =
  | {
      type: 1;
      details: typeof ItemDetails.Type & {
        credentials: typeof LoginCredentials.Type;
      };
    }
  | { type: 2; details: typeof ItemDetails.Type }
  | {
      type: typeof ExtraItemType.Type;
      details: typeof ItemDetails.Type & {
        data: Readonly<Record<string, string | null>>;
      };
    };

export const itemContent = (
  type: ItemType,
  details: typeof ItemDetails.Type,
): ItemContent => {
  if (type === 1)
    return {
      type,
      details: { ...details, credentials: details.credentials ?? {} },
    };
  if (type === 2) return { type, details };
  return { type, details: { ...details, data: details.data ?? {} } };
};
