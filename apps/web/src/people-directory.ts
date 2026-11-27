import {
  button,
  item,
  ItemActionMenu,
  itemGroup,
  navigationLinks,
  outlineIcon,
  plusIcon,
  Sheet,
  spinner,
  trashIconPaths,
} from "@orumai/ui";
import { Effect } from "effect";
import { Submodel } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import * as Mount from "foldkit/mount";
import {
  contactsListPath,
  contactPath,
  type ContactKind,
  type Person,
} from "./people-contract.ts";
import {
  addContactButtonId,
  canDeleteContact,
  canEditContact,
  contactActionMenu,
  contactActionsId,
  detailEditButtonId,
  dialogId,
  directoryContacts,
  displayName,
  editForm,
  Message,
  type Model,
  primaryEmail,
  profileAvatar,
  profileHeader,
  toContactActionMessage,
} from "./people.ts";
import { screenHeader, screenHeaderBack, workspace } from "./workspace.ts";

type DirectoryMessage = typeof Message.Type;
type Directory = (typeof Model.Type)["directory"];

const sectionLabels = { person: "People", company: "Companies" };
const editIconPaths = ["m4 16 11-11a2.8 2.8 0 0 1 4 4L8 20H4v-4zm9-9 4 4"];

const directoryNavigation = (
  section: ContactKind,
  h: HtmlBuilder<DirectoryMessage>,
) =>
  navigationLinks(
    {
      label: "Contacts sections",
      variant: "sidebar",
      destinations: (["person", "company"] as const).map((kind) => ({
        href: contactsListPath(kind),
        label: sectionLabels[kind],
        current: kind === section,
      })),
    },
    h,
  );

const FocusDetail = Mount.define("FocusPersonDetail", {
  messages: [Message.Mounted],
  execute: ({ element }) =>
    Effect.sync(() => {
      if (element instanceof HTMLElement)
        element.focus({ preventScroll: true });
      return Message.Mounted();
    }),
});

const loading = (label: string, h: HtmlBuilder<DirectoryMessage>) =>
  h.div([h.Class("people-loading")], [spinner(label, h)]);

const loadError = (label: string, h: HtmlBuilder<DirectoryMessage>) =>
  h.div(
    [h.Class("people-list-status")],
    [
      h.p([h.Role("alert")], [label]),
      button(
        {
          variant: "outline",
          size: "sm",
          onClick: Message.RetriedDirectory(),
          children: ["Retry"],
        },
        h,
      ),
    ],
  );

const personItem = (
  person: Person,
  directory: Directory,
  h: HtmlBuilder<DirectoryMessage>,
) => {
  const name = displayName(person);
  const email = primaryEmail(person);
  const subtitle =
    person.kind === "company" ? (person.domains?.[0] ?? email) : email;
  const items = [
    {
      action: "open",
      label: "Open",
      icon: outlineIcon(h, ["M5 12h14m-6-6 6 6-6 6"]),
      disabled: false,
    },
    {
      action: "edit",
      label: "Edit",
      icon: outlineIcon(h, editIconPaths),
      disabled: !canEditContact(directory, person),
    },
    ...(person.self
      ? []
      : ([
          {
            action: "delete",
            label: "Delete",
            icon: outlineIcon(h, trashIconPaths),
            disabled: !canDeleteContact(directory, person),
            destructive: true,
          },
        ] as const)),
  ] as const;
  return item(
    {
      key: person.id,
      href: contactPath(person.id),
      title: name,
      description:
        subtitle && subtitle !== name ? h.span([], [subtitle]) : undefined,
      media: profileAvatar(h, person, email, {
        imageMounted: Message.Mounted(),
      }),
      attributes: ItemActionMenu.rowAttributes(
        person.id,
        toContactActionMessage,
        h,
      ),
      linkAttributes: [
        ...ItemActionMenu.rowLinkAttributes(
          contactActionsId,
          person.id,
          items,
          toContactActionMessage,
          h,
        ),
        ...(directory.selected === person.id ? [h.AriaCurrent("page")] : []),
      ],
      action: contactActionMenu.view(
        {
          model: directory.actions,
          rowKey: person.id,
          label: `Actions for ${name}`,
          items,
          toParentMessage: toContactActionMessage,
        },
        h,
      ),
    },
    h,
  );
};

const listView = (
  directory: Directory,
  section: ContactKind,
  h: HtmlBuilder<DirectoryMessage>,
) => {
  const label = sectionLabels[section];
  const labelLower = label.toLowerCase();
  const records = directoryContacts(directory, section);
  const loadingRecords =
    directory.listRequest || (!directory.records && !directory.listFailed);
  return h.section(
    [
      h.Class("workspace-list people-list"),
      h.AriaLabel(label),
      h.Inert(directory.selected !== null),
      h.Tabindex(-1),
      h.OnUnmount(Message.UnmountedDirectory()),
    ],
    [
      h.div(
        [h.Class("workspace-results")],
        [
          ...(directory.listFailed
            ? [loadError(`Could not load ${labelLower}.`, h)]
            : []),
          ...(records.length
            ? [
                itemGroup(
                  records.map((person) => personItem(person, directory, h)),
                  h,
                ),
              ]
            : loadingRecords
              ? [loading(`Loading ${labelLower}…`, h)]
              : directory.listFailed
                ? []
                : [
                    h.p(
                      [h.Class("people-list-status")],
                      [`No ${labelLower} yet.`],
                    ),
                  ]),
        ],
      ),
    ],
  );
};

const addressList = (
  h: HtmlBuilder<DirectoryMessage>,
  heading: string,
  addresses: readonly string[],
) =>
  addresses.length
    ? [
        h.section(
          [h.Class("people-addresses")],
          [
            h.h3([], [heading]),
            h.ul(
              [],
              addresses.map((address) => h.li([h.Key(address)], [address])),
            ),
          ],
        ),
      ]
    : [];

const detailView = (
  selected: string,
  person: Person | undefined,
  directory: Directory,
  h: HtmlBuilder<DirectoryMessage>,
) => {
  const { records, editRequest, editError } = directory;
  const edit = directory.edit?.id === selected ? directory.edit : null;
  const content = person
    ? [
        ...(editError ? [h.p([h.Role("alert")], [editError])] : []),
        edit
          ? editForm(h, edit, editRequest !== null, displayName(person))
          : profileHeader(
              h,
              displayName(person),
              profileAvatar(h, person, primaryEmail(person), {
                size: "lg",
                imageMounted: Message.Mounted(),
              }),
              h.div(
                [h.Class("people-detail-actions")],
                [
                  button(
                    {
                      variant: "ghost",
                      size: "icon-sm",
                      ariaLabel: "Edit contact",
                      attributes: [
                        h.Id(detailEditButtonId),
                        h.Title("Edit contact"),
                      ],
                      disabled: !canEditContact(directory, person),
                      onClick: Message.EditedRecord(),
                      children: [outlineIcon(h, editIconPaths)],
                    },
                    h,
                  ),
                  ...(person.self
                    ? []
                    : [
                        button(
                          {
                            variant: "ghost",
                            size: "icon-sm",
                            ariaLabel: "Delete contact",
                            attributes: [h.Title("Delete contact")],
                            disabled: !canDeleteContact(directory, person),
                            onClick: Message.RequestedDelete(),
                            children: [outlineIcon(h, trashIconPaths)],
                          },
                          h,
                        ),
                      ]),
                ],
              ),
              person.self && person.name
                ? "Your profile"
                : person.kind === "company"
                  ? "Company"
                  : undefined,
            ),
        ...addressList(h, "Account addresses", person.managedAddresses),
        ...(edit ? [] : addressList(h, "Email addresses", person.addresses)),
        ...(edit || person.kind !== "company"
          ? []
          : addressList(h, "Website domains", person.domains ?? [])),
      ]
    : [
        directory.listFailed
          ? loadError("Could not load the profile.", h)
          : directory.listRequest || !records
            ? loading("Loading profile…", h)
            : h.p([], ["Contact not found."]),
      ];
  return h.article(
    [
      h.Key(selected),
      h.Class("workspace-detail people-detail"),
      h.AriaLabel("Contact details"),
      h.Tabindex(-1),
      ...(edit ? [] : [h.OnMount(FocusDetail())]),
    ],
    [h.div([h.Class("people-detail-content")], content)],
  );
};

export const view = Submodel.defineView<
  Directory,
  DirectoryMessage,
  { section: ContactKind }
>((directory, { section }, h) => {
  const { selected, folderSheet } = directory;
  const person = directory.records?.find(({ id }) => id === selected);
  const currentSection = person?.kind ?? section;
  const backLabel = `Back to ${sectionLabels[currentSection]}`;
  const contactLabel = section === "company" ? "Company" : "Person";
  const toFolderSheetMessage = (message: typeof Sheet.Message.Type) =>
    Message.GotFolderSheetMessage({ message });
  return workspace(
    {
      className: "workspace-stacked people-workspace",
      header: screenHeader(
        {
          title: person ? displayName(person) : sectionLabels[currentSection],
          navigation: [
            ...(selected
              ? [
                  screenHeaderBack(
                    {
                      href: contactsListPath(currentSection),
                      label: backLabel,
                    },
                    h,
                  ),
                ]
              : []),
            h.div(
              [h.Class("workspace-drawer-trigger")],
              [
                button(
                  {
                    variant: "ghost",
                    size: "icon-sm",
                    ariaLabel: "Contact folders",
                    dialogId: folderSheet.id,
                    onClick: toFolderSheetMessage(
                      Sheet.Message.RequestedOpen(),
                    ),
                    children: [outlineIcon(h, ["M4 6h16M4 12h16M4 18h16"])],
                  },
                  h,
                ),
              ],
            ),
          ],
          primaryAction: selected
            ? undefined
            : button(
                {
                  size: "sm",
                  attributes: [h.Id(addContactButtonId)],
                  ariaLabel: `Add ${contactLabel.toLowerCase()}`,
                  dialogId,
                  onClick: Message.Created({ kind: section }),
                  children: [plusIcon(h, "16"), contactLabel],
                },
                h,
              ),
        },
        h,
      ),
      sidebar: directoryNavigation(currentSection, h),
      list: listView(directory, currentSection, h),
      ...(selected
        ? { detail: detailView(selected, person, directory, h) }
        : {}),
      hasSelection: selected !== null,
      sheet: Sheet.sheet(
        {
          model: folderSheet,
          title: "Contact folders",
          content: directoryNavigation(currentSection, h),
          toParentMessage: toFolderSheetMessage,
        },
        h,
      ),
    },
    h,
  );
});
