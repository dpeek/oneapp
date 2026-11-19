import { itemTypes } from "./vault-item-content.ts";

type IdentityField = keyof (typeof itemTypes)[4]["fields"];
type IdentityData = Readonly<Partial<Record<IdentityField, string | null>>>;

const sections = {
  personal: "Personal details",
  identification: "Identification",
  contact: "Contact info",
  address: "Address",
};
type Section = keyof typeof sections;
type Visibility = "visible" | "masked";

const fields: Record<
  IdentityField,
  { section: Section; visibility: Visibility; inputMode?: "email" | "tel" }
> = {
  title: { section: "personal", visibility: "visible" },
  firstName: { section: "personal", visibility: "visible" },
  middleName: { section: "personal", visibility: "visible" },
  lastName: { section: "personal", visibility: "visible" },
  username: { section: "personal", visibility: "visible" },
  company: { section: "personal", visibility: "visible" },
  ssn: { section: "identification", visibility: "masked" },
  passportNumber: { section: "identification", visibility: "masked" },
  licenseNumber: { section: "identification", visibility: "masked" },
  email: { section: "contact", visibility: "visible", inputMode: "email" },
  phone: { section: "contact", visibility: "visible", inputMode: "tel" },
  address1: { section: "address", visibility: "visible" },
  address2: { section: "address", visibility: "visible" },
  address3: { section: "address", visibility: "visible" },
  city: { section: "address", visibility: "visible" },
  state: { section: "address", visibility: "visible" },
  postalCode: { section: "address", visibility: "visible" },
  country: { section: "address", visibility: "visible" },
};

const fieldDefinitions = (Object.keys(fields) as IdentityField[]).map(
  (name) => ({
    name,
    label: itemTypes[4].fields[name],
    ...fields[name],
  }),
);

export const identityEditGroups = (Object.keys(sections) as Section[]).map(
  (section) => ({
    section,
    label: sections[section],
    fields: fieldDefinitions.filter((field) => field.section === section),
  }),
);

const nameFields: readonly IdentityField[] = [
  "title",
  "firstName",
  "middleName",
  "lastName",
];
const streetFields = ["address1", "address2", "address3"] as const;
const localityFields = ["city", "state", "postalCode"] as const;
const addressFields = [...streetFields, ...localityFields, "country"] as const;

export const identityDisplayGroups = (data: IdentityData = {}) => {
  const part = (name: IdentityField) => data[name]?.trim();
  const combinedVisibility = (names: readonly IdentityField[]): Visibility =>
    names.some((name) => part(name) && fields[name].visibility === "masked")
      ? "masked"
      : "visible";
  const fullName = nameFields.map(part).filter(Boolean).join(" ");
  const address = [
    ...streetFields.map(part),
    localityFields.map(part).filter(Boolean).join(", "),
    part("country"),
  ]
    .filter(Boolean)
    .join("\n");

  return identityEditGroups.flatMap(({ section, label, fields }) => {
    if (section === "address") return [];
    const rows: { label: string; value: string; visibility: Visibility }[] =
      fields.flatMap(({ name, label, visibility }) => {
        const value = data[name];
        return !nameFields.includes(name) && value?.trim()
          ? [{ label, value, visibility }]
          : [];
      });
    if (section === "personal" && fullName)
      rows.unshift({
        label: "Name",
        value: fullName,
        visibility: combinedVisibility(nameFields),
      });
    if (section === "contact" && address)
      rows.push({
        label: "Address",
        value: address,
        visibility: combinedVisibility(addressFields),
      });
    return rows.length > 0 ? [{ label, rows }] : [];
  });
};
