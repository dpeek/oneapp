import { avatar as uiAvatar } from "@oneapp/ui";
import type { HtmlBuilder } from "foldkit/html";
import type { MailPerson } from "./inbox-contract.ts";
import type { PersonSummary } from "./people-contract.ts";
import { avatar, profileInitials } from "./people.ts";
import { contactImage } from "./contact-image.ts";
import { websiteIconPath } from "./website-icon-host.ts";

export const mailAvatar = <Message>(
  h: HtmlBuilder<Message>,
  person: PersonSummary | undefined,
  sender: MailPerson,
  imageMounted: Message,
) => {
  const contact = contactImage(person);
  if (person && !contact.company)
    return avatar(h, person, sender.address, sender.name);
  if (!contact.company && sender.appearance?.kind !== "service")
    return avatar(h, person, sender.address, sender.name);
  return h.span(
    [h.Class("person-avatar mail-service-avatar")],
    [
      uiAvatar(
        {
          variant: "square",
          fallback: profileInitials(
            person?.name || sender.name,
            sender.address,
          ),
          src: contact.company
            ? contact.src
            : sender.appearance?.domain
              ? websiteIconPath(sender.appearance.domain)
              : null,
          imageMounted,
        },
        h,
      ),
    ],
  );
};
