import { Schema as AuthSchema } from "@yielded/auth";
import { Schema } from "effect";
import { CompanyAvatarStyle } from "./company-avatar-contract.ts";
import { isCompanyDomain } from "./company-domains.ts";

export const peopleApiPath = "/api/people";
export const contactsPath = "/contacts";
const companiesPath = `${contactsPath}/companies`;
export const contactPath = (id: string) => `${contactsPath}/${id}`;
export const contactsListPath = (kind: ContactKind) =>
  kind === "company" ? companiesPath : contactsPath;
export const selfProfilePath = `${peopleApiPath}/me`;
export const personApiPath = (id: string) => `${peopleApiPath}/${id}`;
export const restoreContactPath = (receipt: string) =>
  `${peopleApiPath}/deletions/${receipt}/restore` as const;
export const personPhotoPath = (id: string, key: string) =>
  `${personApiPath(id)}/photo/${key}`;
export const personLookupPath = (email: string) =>
  peopleApiPath + "?" + new URLSearchParams({ email });

export const personNameLimit = 100;
export const personAddressLimit = 20;
export const companyDomainLimit = 20;
export const profilePhotoLimit = 256 * 1024;
export const profilePhotoSize = 256;
export const PersonId = Schema.String.check(
  Schema.isPattern(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u),
);
export const ContactKind = Schema.Literals(["person", "company"]);
export type ContactKind = typeof ContactKind.Type;

export const ContactsRoute = Schema.Struct({
  id: Schema.NullOr(PersonId),
  section: ContactKind,
});
const isPersonId = Schema.is(PersonId);
export const contactsRouteFor = (
  pathname: string,
): typeof ContactsRoute.Type | null => {
  const path = pathname.replace(/\/$/u, "");
  if (path === contactsPath) return { id: null, section: "person" };
  if (path === companiesPath) return { id: null, section: "company" };
  if (!path.startsWith(`${contactsPath}/`)) return null;
  const id = path.slice(contactsPath.length + 1);
  return isPersonId(id) ? { id, section: "person" } : null;
};

export const normalizePersonEmail = (email: string) =>
  email.trim().toLowerCase();
const readEmail = Schema.decodeUnknownOption(AuthSchema.Email);
export const PersonEmail = Schema.Trim.check(
  Schema.isMaxLength(254),
  Schema.makeFilter((email) => readEmail(email)._tag === "Some"),
);

export const ContactNoiseChange = Schema.Struct({
  address: PersonEmail,
  noise: Schema.Boolean,
});
export const CompanyDomains = Schema.Array(
  Schema.Trim.check(
    Schema.isMaxLength(253),
    Schema.makeFilter(isCompanyDomain),
  ),
).check(Schema.isMaxLength(companyDomainLimit));

export const PersonSummary = Schema.Struct({
  id: PersonId,
  kind: Schema.optionalKey(ContactKind),
  domains: Schema.optionalKey(Schema.Array(Schema.String)),
  iconDomain: Schema.optionalKey(Schema.NullOr(Schema.String)),
  name: Schema.String,
  photo: Schema.NullOr(PersonId),
  avatarStyle: Schema.optionalKey(CompanyAvatarStyle),
  self: Schema.Boolean,
});
export type PersonSummary = typeof PersonSummary.Type;

export const Person = Schema.Struct({
  ...PersonSummary.fields,
  revision: PersonId,
  addresses: Schema.Array(Schema.String),
  managedAddresses: Schema.Array(Schema.String),
});
export type Person = typeof Person.Type;
export const PeopleList = Schema.Struct({ people: Schema.Array(Person) });
export const DeleteContactInput = Schema.Struct({ revision: PersonId });
export const DeletedContact = Schema.Struct({ receipt: PersonId });

export const PersonLookup = Schema.Struct({
  person: Schema.NullOr(Person),
});
export const PersonMatch = Schema.Struct({
  email: Schema.String,
  person: PersonSummary,
});
export type PersonMatch = typeof PersonMatch.Type;

export const PersonDraft = Schema.Struct({
  kind: Schema.optionalKey(ContactKind),
  domains: Schema.optionalKey(CompanyDomains),
  name: Schema.Trim.check(Schema.isMaxLength(personNameLimit)),
  addresses: Schema.Array(PersonEmail).check(
    Schema.isMaxLength(personAddressLimit),
  ),
  noiseChanges: Schema.optionalKey(
    Schema.Array(ContactNoiseChange).check(
      Schema.isMaxLength(personAddressLimit),
    ),
  ),
  revision: Schema.optionalKey(PersonId),
  avatarStyle: Schema.optionalKey(CompanyAvatarStyle),
  photo: Schema.optionalKey(
    Schema.NullOr(
      Schema.String.check(
        Schema.isMaxLength(4 * Math.ceil(profilePhotoLimit / 3)),
        Schema.isPattern(/^[A-Za-z\d+/]+={0,2}$/u),
      ),
    ),
  ),
});
