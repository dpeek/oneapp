import { avatar as uiAvatar } from "@orumai/ui";
import type { HtmlBuilder } from "foldkit/html";
import type { MailPerson } from "./inbox-contract.ts";
import type { PersonSummary } from "./people-contract.ts";
import { profileInitials } from "./people.ts";
import { contactImage } from "./contact-image.ts";
import { websiteIconPath } from "./website-icon-host.ts";

export const mailAvatar = <Message>(
  h: HtmlBuilder<Message>,
  person: PersonSummary | undefined,
  sender: MailPerson,
  imageMounted: Message,
) => {
  const contact = contactImage(person);
  const service = !person && sender.appearance?.kind === "service";
  const domain = service ? sender.appearance?.domain : undefined;
  return uiAvatar(
    {
      variant: contact.company || service ? "square" : "round",
      fallback: profileInitials(person?.name || sender.name, sender.address),
      src: domain ? websiteIconPath(domain) : contact.src,
      fit: "cover",
      imageMounted,
    },
    h,
  );
};
