import {
  backIcon,
  button,
  buttonClassName,
  item,
  itemGroup,
  navigationLinks,
  outlineIcon,
  Sheet,
  spinner,
  trashIconPaths,
} from "@oneapp/ui";
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
  dialogId,
  displayName,
  editForm,
  Message,
  type Model,
  primaryEmail,
  profileAvatar,
  profileHeader,
} from "./people.ts";
import { workspace } from "./workspace.ts";

type DirectoryMessage = typeof Message.Type;
type Directory = (typeof Model.Type)["directory"];

const sectionLabels = { person: "People", company: "Companies" };
const names = new Intl.Collator(undefined, { sensitivity: "base" });

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
  selected: Directory["selected"],
  h: HtmlBuilder<DirectoryMessage>,
) => {
  const name = displayName(person);
  const email = primaryEmail(person);
  const subtitle =
    person.kind === "company" ? (person.domains?.[0] ?? email) : email;
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
      linkAttributes: selected === person.id ? [h.AriaCurrent("page")] : [],
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
  const records = (directory.records ?? [])
    .filter(({ kind }) => (kind ?? "person") === section)
    .sort(
      (first, second) =>
        names.compare(displayName(first), displayName(second)) ||
        names.compare(primaryEmail(first), primaryEmail(second)),
    );
  const loadingRecords =
    directory.listRequest || (!directory.records && !directory.listFailed);
  return h.section(
    [
      h.Class("workspace-list people-list"),
      h.AriaLabel(label),
      h.Inert(directory.selected !== null),
      h.Tabindex(-1),
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
                  records.map((person) =>
                    personItem(person, directory.selected, h),
                  ),
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
  const { records, edit, editRequest, editError, deletion, listRequest } =
    directory;
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
              [
                button(
                  {
                    size: "sm",
                    disabled:
                      editRequest !== null ||
                      listRequest !== null ||
                      deletion?.id === person.id,
                    onClick: Message.EditedRecord(),
                    children: ["Edit"],
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
                          rounded: true,
                          ariaLabel: "Delete contact",
                          attributes: [h.Title("Delete contact")],
                          disabled:
                            editRequest !== null ||
                            listRequest !== null ||
                            deletion !== null,
                          onClick: Message.RequestedDelete(),
                          children: [outlineIcon(h, trashIconPaths)],
                        },
                        h,
                      ),
                    ]),
              ],
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
      h.OnMount(FocusDetail()),
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
  const toFolderSheetMessage = (message: typeof Sheet.Message.Type) =>
    Message.GotFolderSheetMessage({ message });
  return workspace(
    {
      className: "workspace-stacked people-workspace",
      title: selected ? undefined : sectionLabels[section],
      headerActions: [
        ...(selected
          ? [
              h.a(
                [
                  h.Href(contactsListPath(currentSection)),
                  h.Class(
                    buttonClassName({
                      variant: "ghost",
                      size: "icon-sm",
                      rounded: true,
                    }),
                  ),
                  h.DataAttribute("slot", "button"),
                  h.AriaLabel(backLabel),
                  h.Title(backLabel),
                ],
                [backIcon(h)],
              ),
            ]
          : []),
        h.div(
          [h.Class("workspace-drawer-trigger")],
          [
            button(
              {
                variant: "ghost",
                size: "icon",
                rounded: true,
                ariaLabel: "Contact folders",
                dialogId: folderSheet.id,
                onClick: toFolderSheetMessage(Sheet.Message.RequestedOpen()),
                children: [outlineIcon(h, ["M4 6h16M4 12h16M4 18h16"])],
              },
              h,
            ),
          ],
        ),
        ...(selected
          ? []
          : [
              button(
                {
                  size: "sm",
                  dialogId,
                  onClick: Message.Created({ kind: section }),
                  children: [
                    section === "company" ? "Add company" : "Add person",
                  ],
                },
                h,
              ),
            ]),
      ],
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
