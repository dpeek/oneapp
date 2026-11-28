import { workspacePath } from "@orumai/core";
import { MailboxId } from "@orumai/core/mail-import";
import { Schema } from "effect";
import { PersonEmail } from "./people-contract.ts";

export const mailSettingsPath = `${workspacePath}/settings/mail`;
export const mailSettingsApiPath = "/api/mail-settings";
export const mailboxesApiPath = `${mailSettingsApiPath}/mailboxes`;
export const inboundRoutesApiPath = `${mailSettingsApiPath}/routes`;

export const mailDomains = [
  "dpeek.com",
  "orumai.app",
  "winterpeek.com",
] as const;
export const defaultMailboxId = "personal";
export const retiredMailAddress = "mail@app.dpeek.com";

export const MailboxName = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
);
export const Mailbox = Schema.Struct({ id: MailboxId, name: MailboxName });
export type Mailbox = typeof Mailbox.Type;
export const Mailboxes = Schema.Struct({ mailboxes: Schema.Array(Mailbox) });
export const NewMailbox = Schema.Struct({ name: MailboxName });

export const InboundRoute = Schema.Struct({
  address: PersonEmail,
  mailboxId: MailboxId,
  enabled: Schema.Boolean,
});
export type InboundRoute = typeof InboundRoute.Type;
export const MailSettings = Schema.Struct({
  domains: Schema.Array(Schema.Literals(mailDomains)),
  routes: Schema.Array(InboundRoute),
  destinations: Schema.Array(Mailbox),
  mailboxes: Schema.Array(Mailbox),
});

export const mailboxParameter = "mailbox";

export const mailboxUrl = (path: string, mailboxId: string) => {
  if (mailboxId === defaultMailboxId) return path;
  const [location = "", fragment] = path.split("#", 2);
  return (
    location +
    (location.includes("?") ? "&" : "?") +
    new URLSearchParams({ [mailboxParameter]: mailboxId }) +
    (fragment === undefined ? "" : `#${fragment}`)
  );
};
