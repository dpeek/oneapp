import { personPhotoPath, type PersonSummary } from "./people-contract.ts";
import { websiteIconPath } from "./website-icon-host.ts";

export const contactImage = (contact: PersonSummary | null | undefined) => {
  const company = contact?.kind === "company";
  const domain = company
    ? (contact.domains?.[0] ?? contact.iconDomain)
    : undefined;
  return {
    company,
    src: contact?.photo
      ? personPhotoPath(contact.id, contact.photo)
      : domain
        ? websiteIconPath(domain)
        : null,
  };
};
