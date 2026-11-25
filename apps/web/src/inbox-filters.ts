import { button, MultiCombobox, Popover } from "@oneapp/ui";
import { Effect, Option, Schema } from "effect";
import { Command, Submodel, Update } from "foldkit";
import { focus } from "foldkit/dom";
import { defineMessageUnion } from "foldkit/message";
import { filterChoice, filterMenu } from "./filter-menu.ts";
import {
  emptyMailFilters,
  mailFilterCount,
  MailFilters,
  MailReadFilter,
} from "./inbox-contract.ts";
import { PeopleList, peopleApiPath, PersonId } from "./people-contract.ts";
import { displayName, primaryEmail } from "./people.ts";

const ContactCategory = Schema.Literals(["people", "companies"]);
const Category = Schema.Literals(["status", ...ContactCategory.literals]);
const optionsId = "mail-filter-options";
const popover = Popover.init({ id: "mail-filters" });
const closedOptions = {
  category: null,
  picker: MultiCombobox.init("mail-filter-contacts"),
};
const closedMenu = {
  ...closedOptions,
  popover,
  contacts: null,
  contactsRequest: null,
  contactsFailed: false,
};

export const Model = Schema.Struct({
  selection: MailFilters,
  popover: Popover.Model,
  category: Schema.NullOr(Category),
  picker: MultiCombobox.Model,
  contacts: Schema.NullOr(PeopleList.fields.people),
  contactsRequest: Schema.NullOr(Schema.String),
  contactsFailed: Schema.Boolean,
});
type Model = typeof Model.Type;

export const initial: Model = { ...closedMenu, selection: emptyMailFilters };
export const resetMenu = (model: Model): Model => ({ ...model, ...closedMenu });

export const Message = defineMessageUnion({
  GotPopoverMessage: { message: Popover.Message },
  OpenedCategory: { category: Category, focusOptions: Schema.Boolean },
  ClosedCategory: {},
  SelectedStatus: { status: MailReadFilter },
  GotContactsMessage: {
    category: ContactCategory,
    message: MultiCombobox.Message,
  },
  Cleared: {},
  RetriedContacts: {},
  LoadedContacts: { request: Schema.String, ...PeopleList.fields },
  ContactsFailed: { request: Schema.String },
  SessionExpired: { request: Schema.String },
  FocusUpdated: {},
});
type Message = typeof Message.Type;

const toPopoverMessage = (message: typeof Popover.Message.Type) =>
  Message.GotPopoverMessage({ message });

const foldPopover = Update.foldChild({
  update: Popover.update,
  read: (model: Model) => Option.some(model.popover),
  write: (model, popover) => ({ ...model, popover }),
  toParentMessage: toPopoverMessage,
  foldOutMessage: (out) => (model) => ({
    model:
      out._tag === "Closed"
        ? {
            ...model,
            ...closedOptions,
            contacts: null,
            contactsRequest: null,
            contactsFailed: false,
          }
        : model,
  }),
});

const foldContacts = (category: typeof ContactCategory.Type) =>
  Update.foldChild({
    update: MultiCombobox.update,
    read: (model: Model) =>
      model.category === category ? Option.some(model.picker) : Option.none(),
    write: (model, picker) => ({ ...model, picker }),
    toParentMessage: (message) =>
      Message.GotContactsMessage({ category, message }),
    foldOutMessage: (out) => (model) => {
      if (out._tag !== "Selected" || !Schema.is(PersonId)(out.value))
        return { model };
      const ids = model.selection[category];
      const selected = ids.includes(out.value)
        ? ids.filter((id) => id !== out.value)
        : [...ids, out.value];
      return {
        model: {
          ...model,
          selection: { ...model.selection, [category]: selected },
        },
      };
    },
  });

const contactUpdates = {
  people: foldContacts("people"),
  companies: foldContacts("companies"),
};

const FocusFilter = Command.define("FocusMailFilter", {
  args: { target: Schema.Literals(["options", "button"]) },
  messages: [Message.FocusUpdated],
  execute: ({ target }) =>
    focus(
      target === "options"
        ? `#${optionsId} input:checked, #${optionsId} input[role="combobox"]`
        : `#${Popover.buttonId(popover.id)}`,
      { preventScroll: true },
    ).pipe(Effect.ignore, Effect.as(Message.FocusUpdated())),
});

const LoadContacts = Command.define("LoadMailFilterContacts", {
  args: { request: Schema.String },
  messages: [
    Message.LoadedContacts,
    Message.ContactsFailed,
    Message.SessionExpired,
  ],
  execute: ({ request }) =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(peopleApiPath, {
        cache: "no-store",
        signal,
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      if (!response.ok) return Message.ContactsFailed({ request });
      const contacts = Schema.decodeUnknownSync(PeopleList)(
        await response.json(),
      );
      return Message.LoadedContacts({ request, ...contacts });
    }).pipe(
      Effect.catch(() => Effect.succeed(Message.ContactsFailed({ request }))),
    ),
});

const loadContacts = (model: Model): Update.Return<Model, Message> => {
  if (model.contactsRequest || model.contacts) return { model };
  const request = crypto.randomUUID();
  return {
    model: { ...model, contactsRequest: request, contactsFailed: false },
    commands: [LoadContacts({ request })],
  };
};

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match(message, {
    GotPopoverMessage: ({ message }) => foldPopover(model, message),
    OpenedCategory: ({ category, focusOptions }) => {
      if (!model.popover.isOpen) return { model };
      const next =
        model.category === category
          ? model
          : { ...model, category, picker: closedOptions.picker };
      const result =
        category === "status" ? { model: next } : loadContacts(next);
      return focusOptions
        ? {
            ...result,
            commands: [
              FocusFilter({ target: "options" }),
              ...(result.commands ?? []),
            ],
          }
        : result;
    },
    ClosedCategory: () => ({ model: { ...model, ...closedOptions } }),
    SelectedStatus: ({ status }) => ({
      model:
        status === model.selection.status
          ? model
          : { ...model, selection: { ...model.selection, status } },
    }),
    GotContactsMessage: ({ category, message }) =>
      contactUpdates[category](model, message),
    Cleared: () => {
      const cleared = mailFilterCount(model.selection)
        ? { ...model, selection: emptyMailFilters }
        : model;
      return model.popover.isOpen
        ? foldPopover(cleared, Popover.Message.RequestedClose())
        : { model: cleared, commands: [FocusFilter({ target: "button" })] };
    },
    RetriedContacts: () => loadContacts(model),
    LoadedContacts: ({ request, people }) => ({
      model:
        request === model.contactsRequest
          ? { ...model, contacts: people, contactsRequest: null }
          : model,
    }),
    ContactsFailed: ({ request }) => ({
      model:
        request === model.contactsRequest
          ? { ...model, contactsFailed: true, contactsRequest: null }
          : model,
    }),
    SessionExpired: () => ({ model }),
    FocusUpdated: () => ({ model }),
  });

const categories = [
  { id: "status", label: "Status" },
  { id: "people", label: "People" },
  { id: "companies", label: "Companies" },
] as const;
const statusLabels = { all: "All", read: "Read", unread: "Unread" };
const names = new Intl.Collator(undefined, { sensitivity: "base" });

export const view = Submodel.defineView<Model, Message>((model, h) =>
  filterMenu(
    {
      popover: model.popover,
      category: model.category,
      categories,
      count: mailFilterCount(model.selection),
      optionsId,
      onOpen: (category, focusOptions) =>
        Message.OpenedCategory({ category, focusOptions }),
      close: Message.ClosedCategory(),
      clear: Message.Cleared(),
      toPopoverMessage,
      options: (category) => {
        if (category === "status")
          return MailReadFilter.literals.map((status) =>
            filterChoice(
              {
                label: statusLabels[status],
                checked: model.selection.status === status,
                message: Message.SelectedStatus({ status }),
                radioGroup: "mail-read-filter",
              },
              h,
            ),
          );
        const label = category === "people" ? "people" : "companies";
        const kind = category === "people" ? "person" : "company";
        const query = model.picker.inputValue.trim().toLowerCase();
        const items = (model.contacts ?? [])
          .filter(
            (person) =>
              (person.kind ?? "person") === kind &&
              [
                displayName(person),
                ...person.addresses,
                ...person.managedAddresses,
                ...(person.domains ?? []),
              ].some((field) => field.toLowerCase().includes(query)),
          )
          .sort(
            (a, b) =>
              names.compare(displayName(a), displayName(b)) ||
              names.compare(primaryEmail(a), primaryEmail(b)),
          )
          .map((person) => ({ id: person.id, name: displayName(person) }));
        return [
          MultiCombobox.view(
            {
              model: model.picker,
              label: `Search ${label}`,
              placeholder: `Search ${label}…`,
              emptyMessage: model.contactsFailed
                ? `Could not load ${label}.`
                : model.contacts === null
                  ? `Loading ${label}…`
                  : query
                    ? `No matching ${label}.`
                    : `No ${label} yet.`,
              items,
              selectedValues: model.selection[category],
              toParentMessage: (message) =>
                Message.GotContactsMessage({ category, message }),
            },
            h,
          ),
          ...(model.contactsFailed
            ? [
                button(
                  {
                    size: "sm",
                    variant: "outline",
                    onClick: Message.RetriedContacts(),
                    children: ["Retry"],
                  },
                  h,
                ),
              ]
            : []),
        ];
      },
    },
    h,
  ),
);
