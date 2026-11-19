import { Effect } from "effect";
import { Submodel } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import * as Mount from "foldkit/mount";
import { peoplePath, personPath, type Person } from "./people-contract.ts";
import { avatar, editForm, Message, type Model } from "./people.ts";

type DirectoryMessage = typeof Message.Type;
type Directory = (typeof Model.Type)["directory"];

const primaryEmail = (person: Person) =>
  person.managedAddresses[0] ?? person.addresses[0] ?? "";
const displayName = (person: Person) =>
  person.name || (person.self ? "Your profile" : primaryEmail(person));

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

const listView = (directory: Directory, h: HtmlBuilder<DirectoryMessage>) => {
  const records = [...(directory.records ?? [])].sort(
    (first, second) =>
      names.compare(displayName(first), displayName(second)) ||
      names.compare(primaryEmail(first), primaryEmail(second)),
  );
  const pending = directory.listRequest !== null;
  return h.section(
    [h.Class("workspace-list"), h.AriaLabel("People records")],
    [
      h.header(
        [h.Class("workspace-list-header people-list-header")],
        [
          h.button(
            [
              h.Type("button"),
              h.Disabled(pending || directory.edit !== null),
              h.OnClick(Message.RetriedDirectory()),
            ],
            [directory.listFailed ? "Retry" : "Refresh"],
          ),
        ],
      ),
      h.div(
        [h.Class("workspace-results")],
        [
          ...(pending
            ? [
                h.p(
                  [h.Class("people-list-status"), h.Role("status")],
                  ["Loading people…"],
                ),
              ]
            : []),
          ...(directory.listFailed
            ? [
                h.p(
                  [h.Class("people-list-status"), h.Role("alert")],
                  ["Could not load people."],
                ),
              ]
            : []),
          h.ul(
            [h.Class("people-rows")],
            records.map((person) => {
              const name = displayName(person);
              const email = primaryEmail(person);
              return h.li(
                [h.Key(person.id)],
                [
                  h.a(
                    [
                      h.Class("people-row"),
                      h.Href(personPath(person.id)),
                      ...(directory.selected === person.id
                        ? [h.AriaCurrent("page")]
                        : []),
                    ],
                    [
                      avatar(h, person, email),
                      h.span(
                        [],
                        [
                          h.strong([], [name]),
                          ...(email && email !== name
                            ? [h.span([], [email])]
                            : []),
                        ],
                      ),
                    ],
                  ),
                ],
              );
            }),
          ),
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

const detailView = (directory: Directory, h: HtmlBuilder<DirectoryMessage>) => {
  const { selected, records, edit, editRequest, editError } = directory;
  if (!selected)
    return h.div(
      [h.Class("workspace-detail")],
      ["Select a person to view their profile."],
    );

  const person = records?.find(({ id }) => id === selected);
  return h.article(
    [
      h.Key(selected),
      h.Class("workspace-detail people-detail"),
      h.AriaLabel("Person details"),
      h.Tabindex(-1),
      h.OnMount(FocusDetail()),
    ],
    [
      h.a([h.Href(peoplePath)], ["Back"]),
      ...(person
        ? [
            h.header(
              [h.Class("people-detail-header")],
              [
                avatar(h, person, primaryEmail(person)),
                h.h2([], [edit ? "Edit profile" : displayName(person)]),
                ...(!edit
                  ? [
                      h.button(
                        [
                          h.Type("button"),
                          h.Disabled(
                            editRequest !== null ||
                              directory.listRequest !== null,
                          ),
                          h.OnClick(Message.EditedRecord()),
                        ],
                        ["Edit"],
                      ),
                    ]
                  : []),
              ],
            ),
            ...(!edit && person.self && person.name
              ? [h.p([h.Class("people-self")], ["Your profile"])]
              : []),
            ...addressList(h, "Account addresses", person.managedAddresses),
            ...(edit
              ? [
                  ...(editError ? [h.p([h.Role("alert")], [editError])] : []),
                  editForm(h, edit, editRequest !== null),
                ]
              : addressList(h, "Email addresses", person.addresses)),
          ]
        : [
            directory.listRequest
              ? h.p([h.Role("status")], ["Loading profile…"])
              : directory.listFailed
                ? h.p([h.Role("alert")], ["Could not load the profile."])
                : h.p([], ["Person not found."]),
            ...(directory.listFailed
              ? [
                  h.button(
                    [h.Type("button"), h.OnClick(Message.RetriedDirectory())],
                    ["Retry"],
                  ),
                ]
              : []),
          ]),
    ],
  );
};

export const view = Submodel.defineView<Directory, DirectoryMessage>(
  (directory, h) =>
    h.div(
      [
        h.Class("workspace people-workspace"),
        ...(directory.selected ? [h.DataAttribute("panel", "")] : []),
      ],
      [
        h.header([h.Class("workspace-header")], [h.h1([], ["People"])]),
        h.nav(
          [h.Class("workspace-sidebar"), h.AriaLabel("People navigation")],
          [
            h.ul(
              [h.Class("workspace-nav-list")],
              [
                h.li(
                  [],
                  [
                    h.a(
                      [h.Href(peoplePath), h.AriaCurrent("true")],
                      ["All people"],
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
        listView(directory, h),
        detailView(directory, h),
      ],
    ),
);
