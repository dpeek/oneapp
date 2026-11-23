import { Schema as AuthSchema } from "@yielded/auth";
import { Schema } from "effect";
import { isCompanyDomain } from "./company-domains.ts";

export const peopleApiPath = "/api/people";
export const contactsPath = "/contacts";
export const contactPath = (id: string) => `${contactsPath}/${id}`;
export const selfProfilePath = `${peopleApiPath}/me`;
export const personApiPath = (id: string) => `${peopleApiPath}/${id}`;
export const personPhotoPath = (id: string, key: string) =>
  `${personApiPath(id)}/photo/${key}`;
export const personLookupPath = (email: string) =>
  peopleApiPath + "?" + new URLSearchParams({ email });

export const personNameLimit = 100;
export const personAddressLimit = 20;
export const profilePhotoLimit = 256 * 1024;
export const profilePhotoSize = 256;
export const PersonId = Schema.String.check(
  Schema.isPattern(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u),
);
export const ContactsRoute = Schema.Struct({ id: Schema.NullOr(PersonId) });
const isPersonId = Schema.is(PersonId);
export const contactsRouteFor = (
  pathname: string,
): typeof ContactsRoute.Type | null => {
  const path = pathname.replace(/\/$/u, "");
  if (path === contactsPath) return { id: null };
  if (!path.startsWith(`${contactsPath}/`)) return null;
  const id = path.slice(contactsPath.length + 1);
  return isPersonId(id) ? { id } : null;
};

export const normalizePersonEmail = (email: string) =>
  email.trim().toLowerCase();
const readEmail = Schema.decodeUnknownOption(AuthSchema.Email);
export const PersonEmail = Schema.Trim.check(
  Schema.isMaxLength(254),
  Schema.makeFilter((email) => readEmail(email)._tag === "Some"),
);

export const ContactKind = Schema.Literals(["person", "company"]);
export const CompanyDomains = Schema.Array(
  Schema.Trim.check(
    Schema.isMaxLength(253),
    Schema.makeFilter(isCompanyDomain),
  ),
).check(Schema.isMaxLength(20));

export const PersonSummary = Schema.Struct({
  id: PersonId,
  kind: Schema.optionalKey(ContactKind),
  domains: Schema.optionalKey(Schema.Array(Schema.String)),
  iconDomain: Schema.optionalKey(Schema.NullOr(Schema.String)),
  name: Schema.String,
  photo: Schema.NullOr(PersonId),
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

export const PersonLookup = Schema.Struct({
  person: Schema.NullOr(Person),
  companySuggestion: Schema.optionalKey(Schema.NullOr(Person)),
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
  revision: Schema.optionalKey(PersonId),
  photo: Schema.optionalKey(
    Schema.NullOr(
      Schema.String.check(
        Schema.isMaxLength(4 * Math.ceil(profilePhotoLimit / 3)),
        Schema.isPattern(/^[A-Za-z\d+/]+={0,2}$/u),
      ),
    ),
  ),
});
