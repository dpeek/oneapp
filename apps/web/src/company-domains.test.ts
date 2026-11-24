import { expect, it } from "@effect/vitest";
import { companyForHostname, isCompanyDomain } from "./company-domains.ts";
import { contactImage } from "./contact-image.ts";
import { personPhotoPath, type PersonSummary } from "./people-contract.ts";
import { websiteIconPath } from "./website-icon-host.ts";

it("accepts company hosts but rejects URLs, public suffixes, and private network names", () => {
  for (const domain of ["ACME.COM.", "accounts.acme.co.uk", "acme.github.io"])
    expect(isCompanyDomain(domain)).toBe(true);
  for (const domain of [
    "com",
    "co.uk",
    "github.io",
    "localhost",
    "127.0.0.1",
    "acme.local",
    "https://acme.com",
    "acme.com/path",
    "*.acme.com",
  ])
    expect(isCompanyDomain(domain)).toBe(false);
});

it("matches only explicit company domains, with DNS boundaries and the most specific domain winning", () => {
  const company = {
    kind: "company" as const,
    domains: ["acme.com", "acme.co.uk"],
  };
  const subsidiary = {
    kind: "company" as const,
    domains: ["division.acme.com"],
  };
  const person = { kind: "person" as const, domains: ["person.com"] };
  const companies = [company, subsidiary, person];
  expect(companyForHostname(companies, "LOGIN.ACME.COM.")).toBe(company);
  expect(companyForHostname(companies, "acme.co.uk")).toBe(company);
  expect(companyForHostname(companies, "login.division.acme.com")).toBe(
    subsidiary,
  );
  for (const host of [
    undefined,
    "notacme.com",
    "acme.com.evil.net",
    "person.com",
  ])
    expect(companyForHostname(companies, host)).toBeUndefined();
});

it("shares company favicon defaults and logo overrides while preserving person portraits", () => {
  const company: PersonSummary = {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Acme",
    kind: "company",
    domains: ["acme.com"],
    iconDomain: "fallback.com",
    photo: null,
    self: false,
  };
  expect(contactImage(company)).toEqual({
    company: true,
    src: websiteIconPath("acme.com"),
  });
  expect(contactImage({ ...company, domains: [] }).src).toBe(
    websiteIconPath("fallback.com"),
  );
  const photo = "00000000-0000-0000-0000-000000000002";
  expect(contactImage({ ...company, photo }).src).toBe(
    personPhotoPath(company.id, photo),
  );
  expect(contactImage({ ...company, kind: "person" })).toEqual({
    company: false,
    src: null,
  });
  expect(contactImage({ ...company, kind: "person", photo }).src).toBe(
    personPhotoPath(company.id, photo),
  );
});
