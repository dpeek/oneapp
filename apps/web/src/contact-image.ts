import { personPhotoPath, type PersonSummary } from "./people-contract.ts";
import { companyAvatarPath } from "./company-avatar-contract.ts";

export const contactImage = (contact: PersonSummary | null | undefined) => {
  const company = contact?.kind === "company";
  const domain = company
    ? (contact.domains?.[0] ?? contact.iconDomain)
    : undefined;
  return {
    company,
    fit:
      company && contact.avatarStyle === "fit"
        ? ("contain" as const)
        : ("cover" as const),
    src: contact?.photo
      ? personPhotoPath(contact.id, contact.photo)
      : domain
        ? companyAvatarPath(domain)
        : null,
  };
};
