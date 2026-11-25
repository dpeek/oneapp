import { navigationLinks, outlineIcon } from "@oneapp/ui";
import { Option, Schema } from "effect";
import type { Url } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";

export const settingsPath = "/settings";
export const SettingsSection = Schema.Literals([
  "account",
  "notifications",
  "clients",
  "tags",
]);
type SettingsSection = typeof SettingsSection.Type;

const destinations = {
  account: {
    href: settingsPath,
    label: "Account",
    paths: [
      "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2",
      "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
    ],
  },
  notifications: {
    href: `${settingsPath}/notifications`,
    label: "Notifications",
    paths: [
      "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9",
      "M10 21a2 2 0 0 0 4 0",
    ],
  },
  clients: {
    href: `${settingsPath}/clients`,
    label: "Clients",
    paths: ["M16 14H3V4h15v5M6 18h7", "M16 9h5v11h-5z"],
  },
  tags: {
    href: `${settingsPath}/tags`,
    label: "Tags",
    paths: [
      "M3 3h8l10 10a2 2 0 0 1 0 2.8l-5.2 5.2a2 2 0 0 1-2.8 0L3 11V3Z",
      "M7.5 7.5h.01",
    ],
  },
} satisfies Record<
  SettingsSection,
  { href: string; label: string; paths: readonly string[] }
>;

export const settingsSectionPath = (section: SettingsSection) =>
  destinations[section].href;
export const settingsSectionLabel = (section: SettingsSection) =>
  destinations[section].label;

export const settingsSectionFor = ({ pathname, hash }: Url.Url) => {
  const path = pathname.replace(/\/$/u, "");
  if (
    (pathname === "/" || path === settingsPath) &&
    Option.getOrUndefined(hash) === "cli-access"
  )
    return "clients";
  return (
    SettingsSection.literals.find(
      (section) => path === settingsSectionPath(section),
    ) ?? null
  );
};

export const settingsNavigation = <Message>(
  section: SettingsSection,
  h: HtmlBuilder<Message>,
) =>
  navigationLinks(
    {
      label: "Settings sections",
      variant: "sidebar",
      destinations: SettingsSection.literals.map((id) => ({
        href: settingsSectionPath(id),
        label: settingsSectionLabel(id),
        icon: outlineIcon(h, destinations[id].paths),
        current: id === section,
      })),
    },
    h,
  );
