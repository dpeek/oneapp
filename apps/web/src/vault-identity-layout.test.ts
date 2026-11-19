import { expect, it } from "@effect/vitest";
import {
  identityDisplayGroups,
  identityEditGroups,
} from "./vault-identity-layout.ts";

it("groups identity details and masks government identifiers in both views", () => {
  const groups = identityDisplayGroups({
    firstName: "Ada",
    middleName: " ",
    lastName: "Example",
    ssn: "test-ssn",
    passportNumber: "test-passport",
    licenseNumber: "test-licence",
    address1: "10 Example Street",
    postalCode: "00742",
    country: "Example",
  });

  expect(groups.map(({ label }) => label)).toEqual([
    "Personal details",
    "Identification",
    "Contact info",
  ]);
  expect(groups[0]?.rows).toEqual([
    { label: "Name", value: "Ada Example", visibility: "visible" },
  ]);
  expect(groups[1]?.rows.map(({ visibility }) => visibility)).toEqual([
    "masked",
    "masked",
    "masked",
  ]);
  expect(
    identityEditGroups[1]?.fields.map(({ name, visibility }) => [
      name,
      visibility,
    ]),
  ).toEqual([
    ["ssn", "masked"],
    ["passportNumber", "masked"],
    ["licenseNumber", "masked"],
  ]);
  expect(groups[2]?.rows).toEqual([
    {
      label: "Address",
      value: "10 Example Street\n00742\nExample",
      visibility: "visible",
    },
  ]);
  expect(identityDisplayGroups({ email: null, phone: "" })).toEqual([]);
});
