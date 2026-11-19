import { Schema as AuthSchema } from "@yielded/auth";
import { Schema } from "effect";

export const peopleApiPath = "/api/people";
export const peoplePath = "/people";
export const personPath = (id: string) => `${peoplePath}/${id}`;
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
export const PeopleRoute = Schema.Struct({ id: Schema.NullOr(PersonId) });
const isPersonId = Schema.is(PersonId);
export const peopleRouteFor = (
  pathname: string,
): typeof PeopleRoute.Type | null => {
  const path = pathname.replace(/\/$/u, "");
  if (path === peoplePath) return { id: null };
  if (!path.startsWith(`${peoplePath}/`)) return null;
  const id = path.slice(peoplePath.length + 1);
  return isPersonId(id) ? { id } : null;
};

export const normalizePersonEmail = (email: string) =>
  email.trim().toLowerCase();
const readEmail = Schema.decodeUnknownOption(AuthSchema.Email);
export const PersonEmail = Schema.Trim.check(
  Schema.isMaxLength(254),
  Schema.makeFilter((email) => readEmail(email)._tag === "Some"),
);

export const PersonSummary = Schema.Struct({
  id: PersonId,
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
});
export const PersonMatch = Schema.Struct({
  email: Schema.String,
  person: PersonSummary,
});
export type PersonMatch = typeof PersonMatch.Type;

export const PersonDraft = Schema.Struct({
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
