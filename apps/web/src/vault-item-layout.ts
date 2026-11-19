import { itemTypes, type ItemType } from "./vault-item-content.ts";

type StructuredType = Exclude<ItemType, 1 | 2 | 4>;
export type VaultFieldPresentation = {
  visibility: "visible" | "masked";
  inputMode?: "email" | "tel" | "numeric";
  multiline?: true;
  date?: true;
};

const visible = { visibility: "visible" } as const;
const masked = { visibility: "masked" } as const;
const date = { ...visible, date: true } as const;
const layouts = {
  3: {
    label: "Card details",
    fields: {
      cardholderName: visible,
      number: { ...masked, inputMode: "numeric" },
      brand: visible,
      expMonth: { ...visible, inputMode: "numeric" },
      expYear: { ...visible, inputMode: "numeric" },
      code: { ...masked, inputMode: "numeric" },
    },
  },
  5: {
    label: "SSH key",
    fields: {
      privateKey: { ...masked, multiline: true },
      publicKey: { ...visible, multiline: true },
      keyFingerprint: { ...visible, multiline: true },
    },
  },
  6: {
    label: "Bank account details",
    fields: {
      bankName: visible,
      nameOnAccount: visible,
      accountType: visible,
      accountNumber: masked,
      routingNumber: visible,
      branchNumber: visible,
      pin: { ...masked, inputMode: "numeric" },
      swiftCode: masked,
      iban: masked,
      bankContactPhone: { ...visible, inputMode: "tel" },
    },
  },
  7: {
    label: "Driver’s license details",
    fields: {
      firstName: visible,
      middleName: visible,
      lastName: visible,
      licenseNumber: masked,
      dateOfBirth: date,
      issuingCountry: visible,
      issuingState: visible,
      issuingAuthority: visible,
      issueDate: date,
      expirationDate: date,
      licenseClass: visible,
    },
  },
  8: {
    label: "Passport details",
    fields: {
      givenName: visible,
      surname: visible,
      dateOfBirth: date,
      sex: visible,
      birthPlace: visible,
      nationality: visible,
      passportNumber: masked,
      passportType: visible,
      nationalIdentificationNumber: masked,
      issuingCountry: visible,
      issuingAuthority: visible,
      issueDate: date,
      expirationDate: date,
    },
  },
} satisfies {
  [Type in StructuredType]: {
    label: string;
    fields: Record<
      keyof (typeof itemTypes)[Type]["fields"],
      VaultFieldPresentation
    >;
  };
};

export const structuredEditGroup = (type: StructuredType) => {
  const { label, fields } = layouts[type];
  const labels: Readonly<Record<string, string>> = itemTypes[type].fields;
  return {
    label,
    fields: Object.entries<VaultFieldPresentation>(fields).map(
      ([name, field]) => ({
        name,
        label: labels[name]!,
        ...field,
      }),
    ),
  };
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "long",
  timeZone: "UTC",
});
const formatDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value)
    ? dateFormatter.format(date)
    : value;
};

export const structuredDisplayGroup = (
  type: StructuredType,
  data: Readonly<Record<string, string | null>> = {},
) => {
  const { label, fields } = structuredEditGroup(type);
  const month = type === 3 ? data.expMonth?.trim() : undefined;
  const year = type === 3 ? data.expYear?.trim() : undefined;
  const expiry = month && year ? `${month.padStart(2, "0")} / ${year}` : null;
  return {
    label,
    rows: fields.flatMap(({ name, label, visibility, date }) => {
      if (expiry && name === "expMonth")
        return [{ label: "Expiry", value: expiry, visibility }];
      if (expiry && name === "expYear") return [];
      const value = data[name];
      return value?.trim()
        ? [{ label, value: date ? formatDate(value) : value, visibility }]
        : [];
    }),
  };
};
