import {
  calendarIconPaths,
  ellipsisIcon,
  filesIconPaths,
  linkIconPaths,
  mailIconPaths,
  navigationLinks,
  outlineIcon,
  Popover,
  taskIconPaths,
  Tooltip,
  unreadBadge,
} from "@oneapp/ui";
import { Option, Schema, Stream } from "effect";
import { Mount, Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { mapMessage } from "foldkit/mount";
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

export const contactsIconPaths = [
  "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87",
  "M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm3-3.87a4 4 0 0 1 0 7.75",
] as const;

const destinations = [
  {
    page: "links",
    href: "/links",
    label: "Links",
    paths: linkIconPaths,
  },
  {
    page: "mail",
    href: mailPath,
    label: "Mail",
    paths: mailIconPaths,
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
    paths: contactsIconPaths,
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

const primaryPages = new Set<Page>(["mail", "calendar", "tasks", "files"]);
const overflowDestinations = destinations.filter(
  ({ page }) => !primaryPages.has(page),
);
const mobileNavMedia = "(max-width: 40rem)";

export const Model = Schema.Struct({
  tooltips: Schema.Record(Page, Tooltip.Model),
  overflow: Popover.Model,
});
type Model = typeof Model.Type;

export const initial: Model = {
  tooltips: {
    links: Tooltip.init({ id: "nav-links" }),
    mail: Tooltip.init({ id: "nav-mail" }),
    calendar: Tooltip.init({ id: "nav-calendar" }),
    tasks: Tooltip.init({ id: "nav-tasks" }),
    files: Tooltip.init({ id: "nav-files" }),
    vault: Tooltip.init({ id: "nav-vault" }),
    contacts: Tooltip.init({ id: "nav-contacts" }),
    settings: Tooltip.init({ id: "nav-settings" }),
  },
  overflow: Popover.init({ id: "nav-more" }),
};

export const Message = defineMessageUnion({
  GotTooltipMessage: { page: Page, message: Tooltip.Message },
  GotOverflowMessage: { message: Popover.Message },
});
type Message = typeof Message.Type;

const foldTooltip = Update.foldChildAt({
  update: (model, message: typeof Tooltip.Message.Type) => {
    const { model: next, commands } = Tooltip.update(model, message);
    return { model: next, commands };
  },
  readAt: (model: Model, page: Page) => Option.some(model.tooltips[page]),
  writeAt: (model, page, tooltip) => ({
    ...model,
    tooltips: { ...model.tooltips, [page]: tooltip },
  }),
  toParentMessage: (page, message) =>
    Message.GotTooltipMessage({ page, message }),
});

const toOverflowMessage = (message: typeof Popover.Message.Type) =>
  Message.GotOverflowMessage({ message });

export const closeOverflow = () =>
  toOverflowMessage(Popover.Message.RequestedClose());

const foldOverflow = Update.foldChild({
  update: Popover.update,
  read: (model: Model) => Option.some(model.overflow),
  write: (model, overflow) => ({ ...model, overflow }),
  toParentMessage: toOverflowMessage,
  foldOutMessage: () => (model) => ({ model }),
});

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match(message, {
    GotTooltipMessage: ({ page, message }) => foldTooltip(model, page, message),
    GotOverflowMessage: ({ message }) => foldOverflow(model, message),
  });

const WatchNavigationLayout = Mount.defineStream("WatchNavigationLayout", {
  messages: [Message.GotOverflowMessage],
  execute: () =>
    Stream.fromEventListener<MediaQueryListEvent>(
      matchMedia(mobileNavMedia),
      "change",
    ).pipe(
      Stream.filter(({ matches }) => !matches),
      Stream.map(closeOverflow),
    ),
});

const overflowNavigation = <ParentMessage>(
  page: Page,
  model: Model,
  toParentMessage: (message: Message) => ParentMessage,
  h: HtmlBuilder<ParentMessage>,
) => {
  const current = overflowDestinations.find(
    (destination) => destination.page === page,
  );
  return h.div(
    [
      h.Class("app-nav-more"),
      h.DataAttribute("current", String(current !== undefined)),
    ],
    [
      Popover.view(
        {
          model: model.overflow,
          label: "More destinations",
          triggerLabel: current
            ? `More destinations, current page: ${current.label}`
            : "More destinations",
          trigger: h.span(
            [h.Class("app-nav-more-label"), h.AriaHidden(true)],
            [ellipsisIcon(h), h.span([h.Class("app-nav-label")], ["More"])],
          ),
          triggerClassName: "app-nav-link",
          placement: "top-end",
          focusSelector: '[data-slot="navigation-link"]',
          content: navigationLinks(
            {
              label: "Additional destinations",
              variant: "sidebar",
              destinations: overflowDestinations.map((destination) => ({
                href: destination.href,
                label: destination.label,
                icon: outlineIcon(h, destination.paths),
                current: page === destination.page,
              })),
            },
            h,
          ),
          toParentMessage: (message) =>
            toParentMessage(toOverflowMessage(message)),
        },
        h,
      ),
    ],
  );
};

export const navigationView = <ParentMessage>(
  page: Page,
  unreadCount: number,
  model: Model,
  toParentMessage: (message: Message) => ParentMessage,
  h: HtmlBuilder<ParentMessage>,
) =>
  h.nav(
    [
      h.Class("app-nav"),
      h.AriaLabel("Main navigation"),
      h.OnMount(mapMessage(WatchNavigationLayout(), toParentMessage)),
    ],
    [
      ...destinations.map((destination) => {
        const count = destination.page === "mail" ? unreadCount : 0;
        return Tooltip.tooltip(
          {
            model: model.tooltips[destination.page],
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
                  ...(!primaryPages.has(destination.page)
                    ? [h.DataAttribute("overflow", "")]
                    : []),
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
      overflowNavigation(page, model, toParentMessage, h),
    ],
  );
