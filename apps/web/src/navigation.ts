import {
  calendarIconPaths,
  filesIconPaths,
  taskIconPaths,
  Tooltip,
  unreadBadge,
} from "@oneapp/ui";
import { Option, Schema } from "effect";
import { Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { calendarPath } from "./calendar-contract.ts";
import { filesPath } from "./files-contract.ts";
import { mailPath } from "./inbox-contract.ts";
import { contactsPath } from "./people-contract.ts";
import { settingsPath } from "./settings-navigation.ts";
import { tasksPath } from "./tasks-contract.ts";
import { vaultPath } from "./vault-setup-contract.ts";

export const Page = Schema.Literals([
  "links",
  "mail",
  "calendar",
  "tasks",
  "files",
  "vault",
  "contacts",
  "settings",
]);
type Page = typeof Page.Type;

const destinations = [
  {
    page: "links",
    href: "/links",
    label: "Links",
    paths: [
      "M10 13a4 4 0 0 0 6 .4l4-4a4 4 0 0 0-5.7-5.7L12 6",
      "M14 11a4 4 0 0 0-6-.4l-4 4a4 4 0 0 0 5.7 5.7L12 18",
    ],
  },
  {
    page: "mail",
    href: mailPath,
    label: "Mail",
    paths: [
      "M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
      "m3 7 9 6 9-6",
    ],
  },
  {
    page: "calendar",
    href: calendarPath,
    label: "Calendar",
    paths: calendarIconPaths,
  },
  {
    page: "tasks",
    href: tasksPath,
    label: "Tasks",
    paths: taskIconPaths,
  },
  {
    page: "files",
    href: filesPath,
    label: "Files",
    paths: filesIconPaths,
  },
  {
    page: "vault",
    href: vaultPath,
    label: "Vault",
    paths: [
      "M7.5 10V7a4.5 4.5 0 1 1 9 0v3",
      "M6 10h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM12 14v3",
    ],
  },
  {
    page: "contacts",
    href: contactsPath,
    label: "Contacts",
    paths: [
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87",
      "M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm3-3.87a4 4 0 0 1 0 7.75",
    ],
  },
  {
    page: "settings",
    href: settingsPath,
    label: "Settings",
    paths: [
      "M12 8.75a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5Z",
      "M10 3h4l.6 2.3 1.6.9 2.3-.6 2 3.5-1.7 1.7v2.4l1.7 1.7-2 3.5-2.3-.6-1.6.9L14 21h-4l-.6-2.3-1.6-.9-2.3.6-2-3.5 1.7-1.7v-2.4L3.5 9.1l2-3.5 2.3.6 1.6-.9L10 3Z",
    ],
  },
] as const satisfies ReadonlyArray<{
  page: Page;
  href: string;
  label: string;
  paths: readonly string[];
}>;

export const Model = Schema.Record(Page, Tooltip.Model);
type Model = typeof Model.Type;

export const initial: Model = {
  links: Tooltip.init({ id: "nav-links" }),
  mail: Tooltip.init({ id: "nav-mail" }),
  calendar: Tooltip.init({ id: "nav-calendar" }),
  tasks: Tooltip.init({ id: "nav-tasks" }),
  files: Tooltip.init({ id: "nav-files" }),
  vault: Tooltip.init({ id: "nav-vault" }),
  contacts: Tooltip.init({ id: "nav-contacts" }),
  settings: Tooltip.init({ id: "nav-settings" }),
};

export const Message = defineMessageUnion({
  GotTooltipMessage: { page: Page, message: Tooltip.Message },
});
type Message = typeof Message.Type;

const foldTooltip = Update.foldChildAt({
  update: (model, message: typeof Tooltip.Message.Type) => {
    const { model: next, commands } = Tooltip.update(model, message);
    return { model: next, commands };
  },
  readAt: (model: Model, page: Page) => Option.some(model[page]),
  writeAt: (model, page, tooltip) => ({ ...model, [page]: tooltip }),
  toParentMessage: (page, message) =>
    Message.GotTooltipMessage({ page, message }),
});

export const update = (model: Model, { page, message }: Message) =>
  foldTooltip(model, page, message);

export const navigationView = <ParentMessage>(
  page: Page,
  unreadCount: number,
  model: Model,
  toParentMessage: (message: Message) => ParentMessage,
  h: HtmlBuilder<ParentMessage>,
) =>
  h.nav(
    [h.Class("app-nav"), h.AriaLabel("Main navigation")],
    destinations.map((destination) => {
      const count = destination.page === "mail" ? unreadCount : 0;
      return Tooltip.tooltip(
        {
          model: model[destination.page],
          content: destination.label,
          toParentMessage: (message) =>
            toParentMessage(
              Message.GotTooltipMessage({ page: destination.page, message }),
            ),
          renderTrigger: (attributes) =>
            h.a(
              [
                ...attributes,
                h.Class("app-nav-link"),
                h.Href(destination.href),
                h.AriaLabel(
                  count
                    ? `${destination.label}, ${count} unread`
                    : destination.label,
                ),
                ...(page === destination.page ? [h.AriaCurrent("page")] : []),
              ],
              [
                h.svg(
                  [
                    h.ViewBox("0 0 24 24"),
                    h.Fill("none"),
                    h.Stroke("currentColor"),
                    h.StrokeWidth("1.75"),
                    h.StrokeLinecap("round"),
                    h.StrokeLinejoin("round"),
                    h.AriaHidden(true),
                  ],
                  destination.paths.map((path) => h.path([h.D(path)], [])),
                ),
                ...(count ? [unreadBadge(h, count)] : []),
                h.span(
                  [h.Class("app-nav-label"), h.AriaHidden(true)],
                  [destination.label],
                ),
              ],
            ),
        },
        h,
      );
    }),
  );
