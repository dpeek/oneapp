import { expect, it } from "@effect/vitest";
import {
  structuredDisplayGroup,
  structuredEditGroup,
} from "./vault-item-layout.ts";

it("combines card expiry in the read card and keeps both values editable", () => {
  const data = {
    number: "Card number fixture",
    expMonth: "2",
    expYear: "2029",
    code: "Code fixture",
  };
  expect(structuredDisplayGroup(3, data)).toEqual({
    label: "Card details",
    rows: [
      { label: "Card number", value: data.number, visibility: "masked" },
      { label: "Expiry", value: "02 / 2029", visibility: "visible" },
      { label: "Security code", value: data.code, visibility: "masked" },
    ],
  });
  expect(structuredEditGroup(3).fields.map(({ name }) => name)).toContain(
    "expYear",
  );
  expect(structuredDisplayGroup(3, { expMonth: "2" }).rows).toEqual([
    { label: "Expiry month", value: "2", visibility: "visible" },
  ]);
});

it("keeps imported partial document dates and masks document identifiers", () => {
  expect(
    structuredDisplayGroup(8, {
      dateOfBirth: "1995",
      passportNumber: "Passport fixture",
      nationalIdentificationNumber: "National ID fixture",
      expirationDate: "2029-02-31",
    }).rows,
  ).toEqual([
    { label: "Date of birth", value: "1995", visibility: "visible" },
    {
      label: "Passport number",
      value: "Passport fixture",
      visibility: "masked",
    },
    {
      label: "National identification number",
      value: "National ID fixture",
      visibility: "masked",
    },
    { label: "Expiration date", value: "2029-02-31", visibility: "visible" },
  ]);
});
