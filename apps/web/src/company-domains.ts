import { parse } from "tldts";
import { iconHostname } from "./website-icon-host.ts";
import type { PersonSummary } from "./people-contract.ts";

export const normalizeCompanyDomain = (value: string) =>
  value.trim().toLowerCase().replace(/\.$/u, "");
export const isCompanyDomain = (value: string) => {
  const domain = iconHostname(normalizeCompanyDomain(value));
  if (!domain) return false;
  const result = parse(domain, { allowPrivateDomains: true });
  return Boolean(result.domain && (result.isIcann || result.isPrivate));
};

// Longest explicitly assigned domain wins; suffix matching observes DNS boundaries.
export const companyForHostname = <
  T extends Pick<PersonSummary, "kind" | "domains">,
>(
  companies: readonly T[],
  hostname: string | undefined,
): T | undefined => {
  if (!hostname) return undefined;
  const host = normalizeCompanyDomain(hostname);
  let match: T | undefined;
  let length = 0;
  for (const company of companies) {
    if (company.kind !== "company") continue;
    for (const domain of company.domains ?? []) {
      if (
        domain.length > length &&
        (host === domain || host.endsWith(`.${domain}`))
      ) {
        match = company;
        length = domain.length;
      }
    }
  }
  return match;
};
