import {
  backIcon,
  button,
  buttonClassName,
  item,
  itemGroup,
  outlineIcon,
  spinner,
  trashIconPaths,
} from "@oneapp/ui";
import { Effect } from "effect";
import { Submodel } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import * as Mount from "foldkit/mount";
import { contactsPath, contactPath, type Person } from "./people-contract.ts";
import {
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

const names = new Intl.Collator(undefined, { sensitivity: "base" });

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

const listView = (directory: Directory, h: HtmlBuilder<DirectoryMessage>) => {
  const records = [...(directory.records ?? [])].sort(
    (first, second) =>
      names.compare(displayName(first), displayName(second)) ||
      names.compare(primaryEmail(first), primaryEmail(second)),
  );
  const loadingPeople =
    directory.listRequest || (!directory.records && !directory.listFailed);
  return h.section(
    [
      h.Class("workspace-list people-list"),
      h.AriaLabel("Contacts"),
      h.Inert(directory.selected !== null),
      h.Tabindex(-1),
    ],
    [
      h.div(
        [h.Class("workspace-results")],
        [
          ...(directory.listFailed
            ? [loadError("Could not load contacts.", h)]
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
            : loadingPeople
              ? [loading("Loading contacts…", h)]
              : directory.listFailed
                ? []
                : [h.p([h.Class("people-list-status")], ["No contacts yet."])]),
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
  directory: Directory,
  h: HtmlBuilder<DirectoryMessage>,
) => {
  const { records, edit, editRequest, editError, deletion, listRequest } =
    directory;
  const person = records?.find(({ id }) => id === selected);
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

export const view = Submodel.defineView<Directory, DirectoryMessage>(
  (directory, h) => {
    const selected = directory.selected;
    return workspace(
      {
        className: "workspace-stacked people-workspace",
        ...(selected
          ? {
              headerActions: [
                h.a(
                  [
                    h.Href(contactsPath),
                    h.Class(
                      buttonClassName({
                        variant: "ghost",
                        size: "icon-sm",
                        rounded: true,
                      }),
                    ),
                    h.DataAttribute("slot", "button"),
                    h.AriaLabel("Back to Contacts"),
                    h.Title("Back to Contacts"),
                  ],
                  [backIcon(h)],
                ),
              ],
              detail: detailView(selected, directory, h),
            }
          : {
              title: "Contacts",
              headerActions: [
                button(
                  {
                    size: "sm",
                    onClick: Message.Created({ kind: "person" }),
                    children: ["Add contact"],
                  },
                  h,
                ),
              ],
            }),
        list: listView(directory, h),
        hasSelection: selected !== null,
      },
      h,
    );
  },
);
