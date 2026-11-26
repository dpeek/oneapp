import {
  avatar as uiAvatar,
  button,
  buttonGroup,
  Dialog,
  field,
  input,
  ItemActionMenu,
  nativeSelect,
  Sheet,
} from "@orumai/ui";
import { Effect, Option, Schema } from "effect";
import { Command, Render, Submodel, Update } from "foldkit";
import { focus } from "foldkit/dom";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
import { mountContactValues } from "./contact-values.ts";
import {
  peopleApiPath,
  ContactKind,
  PeopleList,
  ContactsRoute,
  DeletedContact,
  Person,
  personAddressLimit,
  personApiPath,
  PersonDraft,
  PersonId,
  personLookupPath,
  PersonLookup,
  personNameLimit,
  type PersonSummary,
  profilePhotoSize,
  restoreContactPath,
  selfProfilePath,
} from "./people-contract.ts";

import { contactImage } from "./contact-image.ts";
import { Action, ContactUndo, Notification } from "./notifications.ts";
import { normalizeCompanyDomain } from "./company-domains.ts";
import { workspaceDrawerMedia } from "./workspace.ts";

export const dialogId = "person-profile-dialog";
const formId = "person-profile-form";
const profileNameSelector = `#${formId} input[name="name"]`;
export const contactActionsId = "contact-actions";
export const addContactButtonId = "add-contact";
export const contactActionMenu = ItemActionMenu.create<
  "open" | "edit" | "delete"
>();
const closedActions = ItemActionMenu.init(contactActionsId);

export const Model = Schema.Struct({
  self: Schema.NullOr(Person),
  selfRequest: Schema.NullOr(Schema.String),
  dialog: Dialog.Model,
  editorKey: Schema.String,
  address: Schema.NullOr(Schema.String),
  suggestedName: Schema.String,
  kind: ContactKind,
  suggestedDomains: Schema.Array(Schema.String),
  creating: Schema.Boolean,
  person: Schema.NullOr(Person),
  ready: Schema.Boolean,
  loadRequest: Schema.NullOr(Schema.String),
  saveRequest: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  directory: Schema.Struct({
    folderSheet: Sheet.Model,
    selected: ContactsRoute.fields.id,
    records: Schema.NullOr(PeopleList.fields.people),
    actions: ItemActionMenu.Model,
    listRequest: Schema.NullOr(Schema.String),
    listFailed: Schema.Boolean,
    edit: Schema.NullOr(Person),
    editRequest: Schema.NullOr(Schema.String),
    editTarget: Schema.NullOr(Person),
    editError: Schema.NullOr(Schema.String),
    deletion: Schema.NullOr(
      Schema.Struct({
        request: Schema.String,
        id: PersonId,
        name: Schema.String,
        kind: ContactKind,
      }),
    ),
    restorations: Schema.Record(Schema.String, ContactUndo),
  }),
});
type Model = typeof Model.Type;
export const initial: Model = {
  self: null,
  selfRequest: null,
  dialog: Dialog.init({ id: dialogId, focusSelector: profileNameSelector }),
  editorKey: "",
  address: null,
  suggestedName: "",
  kind: "person",
  suggestedDomains: [],
  creating: false,
  person: null,
  ready: false,
  loadRequest: null,
  saveRequest: null,
  error: null,
  directory: {
    folderSheet: Sheet.init({ id: "contact-folders" }),
    selected: null,
    records: null,
    actions: closedActions,
    listRequest: null,
    listFailed: false,
    edit: null,
    editRequest: null,
    editTarget: null,
    editError: null,
    deletion: null,
    restorations: {},
  },
};

export const Message = defineMessageUnion({
  GotFolderSheetMessage: { message: Sheet.Message },
  GotDialogMessage: { message: Dialog.Message },
  RequestedSelf: {},
  Opened: {
    address: Schema.NullOr(Schema.String),
    suggestedName: Schema.optionalKey(Schema.String),
    suggestedKind: Schema.optionalKey(ContactKind),
    suggestedDomain: Schema.optionalKey(Schema.String),
  },
  Created: { kind: ContactKind },
  ChangedKind: { kind: ContactKind },
  Closed: {},
  Mounted: {},
  Retried: {},
  Loaded: {
    request: Schema.String,
    person: Schema.NullOr(Person),
  },
  Submitted: {},
  Saved: { request: Schema.String, person: Person },
  Failed: { request: Schema.String, error: Schema.String },
  SessionExpired: { request: Schema.String },
  VisitedDirectory: { id: ContactsRoute.fields.id, refresh: Schema.Boolean },
  RetriedDirectory: {},
  LoadedDirectory: { request: Schema.String, ...PeopleList.fields },
  DirectoryFailed: { request: Schema.String },
  GotActionMenu: { message: ItemActionMenu.Message },
  UnmountedDirectory: {},
  EditedRecord: {},
  CanceledEdit: {},
  SubmittedEdit: {},
  RequestedDelete: {},
  DeletedRecord: { request: Schema.String, ...DeletedContact.fields },
  RequestedRestore: ContactUndo.fields,
  RestoredRecord: { request: Schema.String, person: Person },
  ContactMutationFailed: {
    request: Schema.String,
    error: Schema.String,
    status: Schema.Number,
  },
});
type Message = typeof Message.Type;
export const OutMessage = defineMessageUnion({
  OpenContact: { id: PersonId },
  Notify: { notification: Notification },
  DismissNotification: { key: Schema.String },
});
export type OutMessage = typeof OutMessage.Type;

export const closeFolderSheet = () =>
  Message.GotFolderSheetMessage({ message: Sheet.Message.RequestedClose() });

const foldFolderSheet = Update.foldChild({
  update: Sheet.update,
  read: (model: Model) => Option.some(model.directory.folderSheet),
  write: (model, folderSheet) => ({
    ...model,
    directory: { ...model.directory, folderSheet },
  }),
  toParentMessage: (message) => Message.GotFolderSheetMessage({ message }),
  foldOutMessage: () => (model) => ({ model }),
});

const toDialogMessage = (message: typeof Dialog.Message.Type) =>
  Message.GotDialogMessage({ message });
const foldDialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.dialog),
  write: (model, dialog) => ({ ...model, dialog }),
  toParentMessage: toDialogMessage,
  foldOutMessage: () => (model) => ({ model }),
});

const notificationKey = (id: string) => `contact-save:${id}`;
const deletionKey = (id: string) => `contact-delete:${id}`;
const undoDuration = 10_000;

export const primaryEmail = (person: Person) =>
  person.managedAddresses[0] ??
  person.addresses[0] ??
  person.domains?.[0] ??
  "";
export const displayName = (person: Person) =>
  person.name ||
  (person.self ? "Your profile" : primaryEmail(person) || "Unnamed contact");

type Directory = Model["directory"];
const names = new Intl.Collator(undefined, { sensitivity: "base" });
export const directoryContacts = (directory: Directory, section: ContactKind) =>
  (directory.records ?? [])
    .filter(({ kind }) => (kind ?? "person") === section)
    .sort(
      (first, second) =>
        names.compare(displayName(first), displayName(second)) ||
        names.compare(primaryEmail(first), primaryEmail(second)),
    );

export const canEditContact = (directory: Directory, person: Person) =>
  !directory.edit &&
  !directory.editRequest &&
  !directory.listRequest &&
  directory.deletion?.id !== person.id;

export const canDeleteContact = (directory: Directory, person: Person) =>
  !person.self && !directory.deletion && canEditContact(directory, person);

const editFormId = "person-directory-edit";
export const detailEditButtonId = "edit-contact";
const decodeError = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.String }),
);

const Load = Command.define("LoadPersonProfile", {
  args: { request: Schema.String, address: Schema.NullOr(Schema.String) },
  messages: [Message.Loaded, Message.Failed, Message.SessionExpired],
  execute: ({ request, address }) =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(
        address ? personLookupPath(address) : selfProfilePath,
        { cache: "no-store", signal },
      );
      if (response.status === 401) return Message.SessionExpired({ request });
      if (!response.ok)
        return Message.Failed({
          request,
          error: "Could not load the profile. Try again.",
        });
      const value = await response.json();
      const person = address
        ? Schema.decodeUnknownSync(PersonLookup)(value).person
        : Schema.decodeUnknownSync(Person)(value);
      return Message.Loaded({ request, person });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          Message.Failed({
            request,
            error: "Could not load the profile. Try again.",
          }),
        ),
      ),
    ),
});

const LoadDirectory = Command.define("LoadPeopleDirectory", {
  args: { request: Schema.String },
  messages: [
    Message.LoadedDirectory,
    Message.DirectoryFailed,
    Message.SessionExpired,
  ],
  execute: ({ request }) =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(peopleApiPath, {
        cache: "no-store",
        signal,
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      if (!response.ok) return Message.DirectoryFailed({ request });
      return Message.LoadedDirectory({
        request,
        ...Schema.decodeUnknownSync(PeopleList)(await response.json()),
      });
    }).pipe(
      Effect.catch(() => Effect.succeed(Message.DirectoryFailed({ request }))),
    ),
});

const ContactMutation = defineMessageUnion({
  Delete: { id: PersonId, revision: PersonId },
  Restore: { receipt: PersonId },
});

const MutateContact = Command.define("MutateContact", {
  args: { request: Schema.String, mutation: ContactMutation },
  messages: [
    Message.DeletedRecord,
    Message.RestoredRecord,
    Message.ContactMutationFailed,
    Message.SessionExpired,
  ],
  execute: ({ request, mutation }) =>
    Effect.promise(async (signal) => {
      const deleting = mutation._tag === "Delete";
      const error = deleting
        ? "Could not delete the contact. Try again."
        : "Could not restore the contact. Try Undo again.";
      try {
        const response = await fetch(
          deleting
            ? personApiPath(mutation.id)
            : restoreContactPath(mutation.receipt),
          {
            method: deleting ? "DELETE" : "POST",
            headers: {
              "x-effect-auth-csrf": "1",
              "content-type": "application/json",
            },
            ...(deleting
              ? { body: JSON.stringify({ revision: mutation.revision }) }
              : {}),
            signal,
          },
        );
        if (response.status === 401) return Message.SessionExpired({ request });
        if (!response.ok) {
          const problem = decodeError(await response.json().catch(() => null));
          return Message.ContactMutationFailed({
            request,
            error: problem._tag === "Some" ? problem.value.error : error,
            status: response.status,
          });
        }
        const value: unknown = await response.json();
        return deleting
          ? Message.DeletedRecord({
              request,
              ...Schema.decodeUnknownSync(DeletedContact)(value),
            })
          : Message.RestoredRecord({
              request,
              person: Schema.decodeUnknownSync(Person)(value),
            });
      } catch {
        return Message.ContactMutationFailed({ request, error, status: 0 });
      }
    }),
});

const FocusDirectory = Command.define("FocusPeopleDirectory", {
  args: { id: Schema.NullOr(PersonId), recover: Schema.Boolean },
  messages: [Message.Mounted],
  execute: ({ id, recover }) =>
    Render.afterCommit.pipe(
      Effect.andThen(
        Effect.sync(() => {
          const list = document.querySelector<HTMLElement>(
            ".people-workspace:not([data-panel]) .people-list",
          );
          if (list && (!recover || document.activeElement === document.body)) {
            const trigger =
              recover && id
                ? document.getElementById(
                    ItemActionMenu.triggerId(contactActionsId, id),
                  )
                : null;
            const link = id
              ? document.getElementById(
                  ItemActionMenu.rowLinkId(contactActionsId, id),
                )
              : null;
            const target = trigger?.getClientRects().length
              ? trigger
              : (link ?? document.getElementById(addContactButtonId) ?? list);
            target.focus({ preventScroll: !recover });
          }
          return Message.Mounted();
        }),
      ),
    ),
});

const FocusDirectoryEdit = Command.define("FocusPeopleDirectoryEdit", {
  args: { editing: Schema.Boolean },
  messages: [Message.Mounted],
  execute: ({ editing }) =>
    focus(
      editing ? `#${editFormId} input[name="name"]` : `#${detailEditButtonId}`,
    ).pipe(Effect.ignore, Effect.as(Message.Mounted())),
});

const photoTypes = ["image/jpeg", "image/png", "image/webp"];
const isProfilePhoto = (file: File) =>
  file.size <= 10 * 1024 * 1024 && photoTypes.includes(file.type);

const photoFor = async (file: File) => {
  if (!isProfilePhoto(file))
    throw new Error("Choose a JPEG, PNG, or WebP photo up to 10 MB.");
  const source = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = profilePhotoSize;
    canvas.height = profilePhotoSize;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not process the photo.");
    const side = Math.min(source.width, source.height);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      source,
      (source.width - side) / 2,
      (source.height - side) / 2,
      side,
      side,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return canvas.toDataURL("image/jpeg", 0.86).split(",", 2)[1];
  } finally {
    source.close();
  }
};

const Save = Command.define("SavePersonProfile", {
  args: {
    request: Schema.String,
    person: Schema.NullOr(Person),
    formId: Schema.String,
  },
  messages: [Message.Saved, Message.Failed, Message.SessionExpired],
  execute: ({ request, person, formId }) =>
    Effect.promise(async (signal) => {
      const fail = (error: string) => Message.Failed({ request, error });
      try {
        const form = document.getElementById(formId);
        if (!(form instanceof HTMLFormElement))
          return fail("Reopen the profile and try again.");
        const fields = new FormData(form);
        const file = fields.get("photo");
        const kind = fields.get("kind") === "company" ? "company" : "person";
        const noiseChanges = fields.get("noiseChanges");
        let photo: string | null | undefined = fields.has("removePhoto")
          ? null
          : undefined;
        if (file instanceof File && file.size) {
          try {
            photo = await photoFor(file);
          } catch {
            return fail(
              "Choose a readable JPEG, PNG, or WebP photo up to 10 MB.",
            );
          }
        }
        const decoded = Schema.decodeUnknownOption(PersonDraft)({
          name: fields.get("name"),
          kind,
          domains:
            kind === "company"
              ? fields
                  .getAll("domains")
                  .map((domain) => normalizeCompanyDomain(String(domain)))
                  .filter(Boolean)
              : [],
          addresses: fields
            .getAll("addresses")
            .map((address) => String(address).trim())
            .filter(Boolean),
          ...(noiseChanges
            ? { noiseChanges: JSON.parse(String(noiseChanges)) }
            : {}),
          ...(person ? { revision: person.revision } : {}),
          ...(photo === undefined ? {} : { photo }),
        });
        if (decoded._tag === "None")
          return fail(
            "Enter a name, up to " +
              personAddressLimit +
              " valid email addresses, and valid website domains for a company.",
          );
        const response = await fetch(
          person ? personApiPath(person.id) : peopleApiPath,
          {
            method: person ? "PUT" : "POST",
            headers: {
              "content-type": "application/json",
              "x-effect-auth-csrf": "1",
            },
            body: JSON.stringify(decoded.value),
            signal,
          },
        );
        if (response.status === 401) return Message.SessionExpired({ request });
        if (response.ok)
          return Message.Saved({
            request,
            person: Schema.decodeUnknownSync(Person)(await response.json()),
          });
        const problem = decodeError(await response.json());
        return fail(
          problem._tag === "Some"
            ? problem.value.error
            : "Could not save the profile. Try again.",
        );
      } catch {
        return fail("Could not save the profile. Try again.");
      }
    }),
});

const loadDialog = (model: Model): Update.Return<Model, Message> => {
  const request = crypto.randomUUID();
  return {
    model: { ...model, loadRequest: request, error: null },
    commands: [Load({ request, address: model.address })],
  };
};

const FocusProfileName = Command.define("FocusPersonProfileName", {
  args: {},
  messages: [Message.Mounted],
  execute: () =>
    focus(profileNameSelector).pipe(
      Effect.ignore,
      Effect.as(Message.Mounted()),
    ),
});

const resetEditor = (model: Model): Model => ({
  ...initial,
  dialog: model.dialog,
  self: model.self,
  selfRequest: model.selfRequest,
  directory: model.directory,
});

const loadDirectory = (model: Model): Update.Return<Model, Message> => {
  const request = crypto.randomUUID();
  return {
    model: {
      ...model,
      directory: {
        ...model.directory,
        listRequest: request,
        listFailed: false,
      },
    },
    commands: [LoadDirectory({ request })],
  };
};

const editContact = (
  model: Model,
  person: Person,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> => {
  if (!canEditContact(model.directory, person)) return { model };
  return {
    model: {
      ...model,
      directory: { ...model.directory, edit: person, editError: null },
    },
    ...(model.directory.selected === person.id
      ? { commands: [FocusDirectoryEdit({ editing: true })] }
      : { outMessage: OutMessage.OpenContact({ id: person.id }) }),
  };
};

const deleteContact = (
  model: Model,
  person: Person,
): Update.Return<Model, Message> => {
  if (!canDeleteContact(model.directory, person)) return { model };
  const request = crypto.randomUUID();
  return {
    model: {
      ...model,
      directory: {
        ...model.directory,
        deletion: {
          request,
          id: person.id,
          name: displayName(person),
          kind: person.kind ?? "person",
        },
      },
    },
    commands: [
      MutateContact({
        request,
        mutation: ContactMutation.Delete({
          id: person.id,
          revision: person.revision,
        }),
      }),
    ],
  };
};

export const toContactActionMessage = (message: ItemActionMenu.Message) =>
  Message.GotActionMenu({ message });

const foldContactActions = Update.foldChild({
  update: contactActionMenu.update,
  read: (model: Model) => Option.some(model.directory.actions),
  write: (model, actions) => ({
    ...model,
    directory: { ...model.directory, actions },
  }),
  toParentMessage: toContactActionMessage,
  foldOutMessage:
    ({ key, action }): Update.StepWithOutMessage<Model, Message, OutMessage> =>
    (model) => {
      const person = model.directory.records?.find(({ id }) => id === key);
      if (!person) return { model };
      switch (action) {
        case "open":
          return {
            model,
            outMessage: OutMessage.OpenContact({ id: person.id }),
          };
        case "edit":
          return editContact(model, person);
        case "delete":
          return deleteContact(model, person);
      }
    },
});

export const update = (
  model: Model,
  message: Message,
  directoryVisible = true,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> => {
  const directory = model.directory;
  return Message.match<Update.ReturnWithOutMessage<Model, Message, OutMessage>>(
    message,
    {
      GotFolderSheetMessage: ({ message }) =>
        message._tag === "RequestedOpen" &&
        !matchMedia(workspaceDrawerMedia).matches
          ? { model }
          : foldFolderSheet(model, message),
      RequestedSelf: () => {
        if (model.selfRequest) return { model };
        const request = crypto.randomUUID();
        return {
          model: { ...model, selfRequest: request },
          commands: [Load({ request, address: null })],
        };
      },
      Created: ({ kind }) =>
        model.dialog.isOpen
          ? { model }
          : foldDialog(
              {
                ...resetEditor(model),
                editorKey: crypto.randomUUID(),
                creating: true,
                ready: true,
                kind,
              },
              Dialog.Message.RequestedOpen(),
            ),
      ChangedKind: ({ kind }) => {
        if (model.saveRequest || directory.editRequest) return { model };
        if (directory.edit?.self) return { model };
        if (directory.edit)
          return {
            model: {
              ...model,
              directory: { ...directory, edit: { ...directory.edit, kind } },
            },
          };
        if (model.person?.self) return { model };
        return { model: { ...model, kind } };
      },
      Opened: ({ address, suggestedName, suggestedKind, suggestedDomain }) =>
        model.dialog.isOpen
          ? { model }
          : Update.combine(
              {
                ...resetEditor(model),
                editorKey: crypto.randomUUID(),
                address,
                kind: suggestedKind ?? "person",
                suggestedDomains: suggestedDomain ? [suggestedDomain] : [],
                suggestedName:
                  suggestedName
                    ?.trim()
                    .slice(0, personNameLimit)
                    .replace(/[\uD800-\uDBFF]$/u, "") ?? "",
              },
              [
                (next) => foldDialog(next, Dialog.Message.RequestedOpen()),
                loadDialog,
              ],
            ),
      Closed: () =>
        model.saveRequest
          ? { model }
          : foldDialog(resetEditor(model), Dialog.Message.RequestedClose()),
      GotDialogMessage: ({ message }) =>
        message._tag === "RequestedClose"
          ? update(model, Message.Closed(), directoryVisible)
          : foldDialog(model, message),
      Mounted: () => ({ model }),
      Retried: () =>
        model.dialog.isOpen && !model.loadRequest
          ? loadDialog(model)
          : { model },
      Loaded: ({ request, person }) => {
        if (request === model.selfRequest)
          return { model: { ...model, selfRequest: null, self: person } };
        if (request !== model.loadRequest) return { model };
        return {
          model: {
            ...model,
            loadRequest: null,
            ready: true,
            person,
            kind: person ? (person.kind ?? "person") : model.kind,
            self: person?.self ? person : model.self,
          },
          commands: [FocusProfileName({})],
        };
      },
      Submitted: () => {
        if (!model.ready || !model.dialog.isOpen || model.saveRequest)
          return { model };
        const request = crypto.randomUUID();
        return {
          model: { ...model, saveRequest: request, error: null },
          commands: [Save({ request, person: model.person, formId })],
        };
      },
      Saved: ({ request, person }) => {
        const editing = request === directory.editRequest;
        if (!editing && request !== model.saveRequest) return { model };
        if (editing && directory.editTarget?.id !== person.id) return { model };
        const records = directory.records
          ? [...directory.records.filter(({ id }) => id !== person.id), person]
          : null;
        const next: Model = {
          ...(editing ? model : resetEditor(model)),
          self: person.self ? person : model.self,
          selfRequest: person.self ? null : model.selfRequest,
          directory: {
            ...directory,
            records,
            listRequest: records ? null : directory.listRequest,
            ...(editing
              ? {
                  edit: null,
                  editRequest: null,
                  editTarget: null,
                  editError: null,
                }
              : {}),
          },
        };
        return {
          ...(editing
            ? {
                model: next,
                ...(directoryVisible &&
                directory.selected === person.id &&
                directory.edit?.id === person.id
                  ? { commands: [FocusDirectoryEdit({ editing: false })] }
                  : {}),
              }
            : foldDialog(next, Dialog.Message.RequestedClose())),
          outMessage: OutMessage.DismissNotification({
            key: notificationKey(person.id),
          }),
        };
      },
      Failed: ({ request, error }) => {
        if (request === directory.editRequest) {
          const target = directory.editTarget;
          const visible =
            directoryVisible &&
            target &&
            directory.selected === target.id &&
            directory.edit?.id === target.id;
          return {
            model: {
              ...model,
              directory: {
                ...directory,
                editRequest: null,
                editTarget: null,
                editError: visible ? error : null,
              },
            },
            ...(!visible && target
              ? {
                  outMessage: OutMessage.Notify({
                    notification: {
                      key: notificationKey(target.id),
                      variant: "Error",
                      title:
                        "Could not save the contact. Reopen it in Contacts to try again.",
                      description:
                        target.name || target.addresses[0] || "Unnamed contact",
                    },
                  }),
                }
              : target
                ? {
                    outMessage: OutMessage.DismissNotification({
                      key: notificationKey(target.id),
                    }),
                  }
                : {}),
          };
        }
        if (request === model.selfRequest)
          return { model: { ...model, selfRequest: null } };
        if (request !== model.loadRequest && request !== model.saveRequest)
          return { model };
        return {
          model: { ...model, error, loadRequest: null, saveRequest: null },
          ...(request === model.saveRequest && model.person
            ? {
                outMessage: OutMessage.DismissNotification({
                  key: notificationKey(model.person.id),
                }),
              }
            : {}),
        };
      },
      SessionExpired: () => ({ model }),
      VisitedDirectory: ({ id, refresh }) => {
        const edit =
          !refresh && directory.edit?.id === id ? directory.edit : null;
        const next = {
          ...model,
          directory: {
            ...directory,
            selected: id,
            actions: closedActions,
            edit,
            editError: null,
          },
        };
        const result =
          refresh || (directory.records === null && !directory.listRequest)
            ? loadDirectory(next)
            : { model: next };
        const focusTarget = edit
          ? FocusDirectoryEdit({ editing: true })
          : id === null && directory.selected && !refresh
            ? FocusDirectory({ id: directory.selected, recover: false })
            : null;
        return focusTarget
          ? {
              ...result,
              commands: [...(result.commands ?? []), focusTarget],
            }
          : result;
      },
      RetriedDirectory: () => loadDirectory(model),
      LoadedDirectory: ({ request, people }) =>
        request !== directory.listRequest
          ? { model }
          : {
              model: {
                ...model,
                directory: {
                  ...directory,
                  records: people,
                  listRequest: null,
                  actions: people.some(
                    ({ id }) => id === directory.actions.row?.key,
                  )
                    ? directory.actions
                    : closedActions,
                },
              },
            },
      DirectoryFailed: ({ request }) =>
        request !== directory.listRequest
          ? { model }
          : {
              model: {
                ...model,
                directory: {
                  ...directory,
                  listRequest: null,
                  listFailed: true,
                },
              },
            },
      GotActionMenu: ({ message }) =>
        directoryVisible ? foldContactActions(model, message) : { model },
      UnmountedDirectory: () => ({
        model: {
          ...model,
          directory: { ...directory, actions: closedActions },
        },
      }),
      EditedRecord: () => {
        const person = directory.records?.find(
          ({ id }) => id === directory.selected,
        );
        return directoryVisible && person
          ? editContact(model, person)
          : { model };
      },
      CanceledEdit: () =>
        directory.editRequest
          ? { model }
          : {
              model: {
                ...model,
                directory: { ...directory, edit: null, editError: null },
              },
              commands: [FocusDirectoryEdit({ editing: false })],
            },
      SubmittedEdit: () => {
        if (!directory.edit || directory.editRequest) return { model };
        const request = crypto.randomUUID();
        return {
          model: {
            ...model,
            directory: {
              ...directory,
              editRequest: request,
              editTarget: directory.edit,
              editError: null,
            },
          },
          commands: [
            Save({ request, person: directory.edit, formId: editFormId }),
          ],
        };
      },
      RequestedDelete: () => {
        const person = directory.records?.find(
          ({ id }) => id === directory.selected,
        );
        return directoryVisible && person
          ? deleteContact(model, person)
          : { model };
      },
      DeletedRecord: ({ request, receipt }) => {
        const deletion = directory.deletion;
        if (request !== deletion?.request) return { model };
        const { id, name, kind } = deletion;
        const records =
          directory.records?.filter((person) => person.id !== id) ?? null;
        const sectionRecords = directoryContacts(directory, kind);
        const deletedIndex = sectionRecords.findIndex(
          (person) => person.id === id,
        );
        const neighbor =
          sectionRecords[deletedIndex + 1] ?? sectionRecords[deletedIndex - 1];
        return {
          model: {
            ...model,
            directory: {
              ...directory,
              records,
              actions:
                directory.actions.row?.key === id
                  ? closedActions
                  : directory.actions,
              listRequest: records ? null : directory.listRequest,
              deletion: null,
            },
          },
          ...(directoryVisible &&
          directory.selected === null &&
          deletedIndex >= 0
            ? {
                commands: [
                  FocusDirectory({ id: neighbor?.id ?? null, recover: true }),
                ],
              }
            : {}),
          outMessage: OutMessage.Notify({
            notification: {
              key: deletionKey(id),
              variant: "Success",
              title: "Contact deleted.",
              description: name,
              durationMs: undoDuration,
              action: Action.RestoreContact({ id, receipt, name }),
            },
          }),
        };
      },
      RequestedRestore: ({ id, receipt, name }) => {
        if (
          Object.values(directory.restorations).some(
            (undo) => undo.receipt === receipt,
          )
        )
          return { model };
        const request = crypto.randomUUID();
        return {
          model: {
            ...model,
            directory: {
              ...directory,
              restorations: {
                ...directory.restorations,
                [request]: { id, receipt, name },
              },
            },
          },
          commands: [
            MutateContact({
              request,
              mutation: ContactMutation.Restore({ receipt }),
            }),
          ],
          outMessage: OutMessage.DismissNotification({ key: deletionKey(id) }),
        };
      },
      RestoredRecord: ({ request, person }) => {
        const { [request]: undo, ...restorations } = directory.restorations;
        if (!undo || undo.id !== person.id) return { model };
        const records = directory.records
          ? [...directory.records.filter(({ id }) => id !== person.id), person]
          : null;
        return {
          model: {
            ...model,
            directory: {
              ...directory,
              records,
              listRequest: records ? null : directory.listRequest,
              restorations,
            },
          },
          outMessage: OutMessage.Notify({
            notification: {
              key: deletionKey(person.id),
              variant: "Success",
              title: "Contact restored.",
              description: undo.name,
              durationMs: undoDuration,
            },
          }),
        };
      },
      ContactMutationFailed: ({ request, error, status }) => {
        const { [request]: undo, ...restorations } = directory.restorations;
        const deletion =
          request === directory.deletion?.request ? directory.deletion : null;
        const target = undo ?? deletion;
        if (!target) return { model };
        const next = {
          ...model,
          directory: {
            ...directory,
            restorations,
            deletion: deletion ? null : directory.deletion,
          },
        };
        return {
          ...(directoryVisible &&
          (status === 404 || (deletion && status === 409))
            ? loadDirectory(next)
            : { model: next }),
          outMessage: OutMessage.Notify({
            notification: {
              key: deletionKey(target.id),
              variant: "Error",
              title: error,
              description: target.name,
              ...(undo && (status === 0 || status === 409 || status >= 500)
                ? {
                    action: Action.RestoreContact(undo),
                    durationMs: undoDuration,
                  }
                : {}),
            },
          }),
        };
      },
    },
  );
};

const PrepareForm = Mount.define("PrefillPersonProfileForm", {
  args: { name: Schema.String },
  messages: [Message.Mounted],
  execute: ({ element, name }) =>
    Effect.sync(() => {
      if (element instanceof HTMLFormElement) {
        const nameField = element.elements.namedItem("name");
        if (nameField instanceof HTMLInputElement) nameField.value = name;
      }
      return Message.Mounted();
    }),
});

const MountContactValues = Mount.define("MountContactValues", {
  args: {
    name: Schema.Literals(["addresses", "domains"]),
    values: Schema.Array(Schema.String),
  },
  messages: [Message.Mounted],
  execute: ({ element, name, values }) =>
    Effect.promise(async (signal) => {
      if (element instanceof HTMLFieldSetElement)
        await mountContactValues(element, name, values, signal);
      return Message.Mounted();
    }),
});

const PreviewPhoto = Mount.define("PreviewPersonProfilePhoto", {
  messages: [Message.Mounted],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const input = element.querySelector('input[type="file"]');
        const preview = element.querySelector("img[data-photo-preview]");
        if (
          !(input instanceof HTMLInputElement) ||
          !(preview instanceof HTMLImageElement)
        )
          return;
        let previewUrl: string | null = null;
        const clear = () => {
          preview.hidden = true;
          preview.removeAttribute("src");
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          previewUrl = null;
        };
        const select = () => {
          clear();
          const file = input.files?.[0];
          if (file && isProfilePhoto(file)) {
            previewUrl = URL.createObjectURL(file);
            preview.src = previewUrl;
          }
        };
        const reveal = () => {
          preview.hidden = false;
        };
        input.addEventListener("change", select);
        preview.addEventListener("load", reveal);
        return () => {
          input.removeEventListener("change", select);
          preview.removeEventListener("load", reveal);
          clear();
        };
      }),
      (cleanup) => Effect.sync(() => cleanup?.()),
    ).pipe(Effect.as(Message.Mounted())),
});

export const profileInitials = (name: string, address: string) => {
  const words = (name || address.split("@", 1)[0] || "").match(
    /[\p{L}\p{N}]+/gu,
  );
  return (
    words
      ?.slice(0, 2)
      .map((word) => Array.from(word)[0])
      .join("")
      .toLocaleUpperCase() || "?"
  );
};

export const profileAvatar = <Parent>(
  h: HtmlBuilder<Parent>,
  person: PersonSummary | null,
  address: string,
  options: {
    name?: string;
    size?: "sm" | "lg";
    imageMounted: Parent;
    kind?: typeof ContactKind.Type;
  },
) =>
  uiAvatar(
    {
      fallback: profileInitials(options.name ?? person?.name ?? "", address),
      src: contactImage(person).src,
      variant:
        (options.kind ?? person?.kind) === "company" ? "square" : "round",
      imageMounted: options.imageMounted,
      size: options.size,
      fit: "cover",
    },
    h,
  );

export const profileHeader = (
  h: HtmlBuilder<Message>,
  name: string,
  media: Html,
  actions: ReadonlyArray<Html>,
  subtitle?: string,
) =>
  h.header(
    [h.Class("people-detail-header")],
    [
      h.div(
        [h.Class("people-profile-identity")],
        [
          media,
          h.div(
            [],
            [
              h.h2([], [name]),
              ...(subtitle ? [h.p([h.Class("people-self")], [subtitle])] : []),
            ],
          ),
        ],
      ),
      buttonGroup(actions, h),
    ],
  );

const photoPicker = (
  h: HtmlBuilder<Message>,
  person: Person | null,
  name: string,
  address: string,
  pending: boolean,
  kind: typeof ContactKind.Type,
) => {
  const imageLabel = kind === "company" ? "company logo" : "profile photo";
  const label = `${person?.photo ? "Change" : "Upload"} ${imageLabel}`;
  return h.label(
    [
      h.Class(
        `person-photo-picker${kind === "company" ? " company-photo-picker" : ""}`,
      ),
      h.Title(label),
      h.Inert(pending),
      h.OnMount(PreviewPhoto()),
    ],
    [
      profileAvatar(h, person, address, {
        name,
        kind,
        size: "lg",
        imageMounted: Message.Mounted(),
      }),
      h.img([h.DataAttribute("photo-preview", ""), h.Hidden(true), h.Alt("")]),
      h.span(
        [h.Class("person-photo-picker-icon"), h.AriaHidden(true)],
        [
          h.svg(
            [
              h.ViewBox("0 0 24 24"),
              h.Width("14"),
              h.Height("14"),
              h.Fill("none"),
              h.Stroke("currentColor"),
              h.StrokeWidth("2"),
              h.StrokeLinejoin("round"),
            ],
            [
              h.path([h.D("M4 6h4l2-2h4l2 2h4v14H4z")], []),
              h.circle([h.Cx("12"), h.Cy("13"), h.R("3")], []),
            ],
          ),
        ],
      ),
      h.input([
        h.Name("photo"),
        h.Type("file"),
        h.AriaLabel(label),
        h.Accept(photoTypes.join(",")),
      ]),
    ],
  );
};

const profileForm = (
  h: HtmlBuilder<Message>,
  person: typeof Person.Type | null,
  address: string | null,
  pending: boolean,
  options: {
    formId: string;
    submit: Message;
    cancel: Message;
    suggestedName?: string;
    heading?: string;
    kind?: typeof ContactKind.Type;
    domains?: readonly string[];
    key?: string;
  },
) => {
  const kind = options.kind ?? person?.kind ?? "person";
  const domains = person?.domains ?? options.domains ?? [];
  const emails = person?.addresses ?? (address ? [address] : []);
  const name = person?.name || options.suggestedName || "";
  const photo = photoPicker(
    h,
    person,
    name,
    address ?? emails[0] ?? person?.managedAddresses[0] ?? "",
    pending,
    kind,
  );
  const actions = [
    button(
      {
        variant: "outline",
        size: "sm",
        disabled: pending,
        onClick: options.cancel,
        children: ["Cancel"],
      },
      h,
    ),
    button(
      {
        type: "submit",
        size: "sm",
        disabled: pending,
        focusableWhenDisabled: true,
        children: [pending ? "Saving…" : "Save"],
      },
      h,
    ),
  ];
  return h.form(
    [
      h.Id(options.formId),
      h.Key(`${options.formId}-${options.key ?? person?.id ?? "new"}`),
      h.Class("person-fields"),
      h.OnSubmit(options.submit),
      h.OnMount(PrepareForm({ name })),
    ],
    [
      options.heading
        ? profileHeader(h, options.heading, photo, actions)
        : photo,
      nativeSelect(
        {
          label: "Contact type",
          options: [
            { value: "person", label: "Person" },
            { value: "company", label: "Company" },
          ],
          value: kind,
          disabled: pending || Boolean(person?.self),
          onChange: (value) =>
            Message.ChangedKind({
              kind: value === "company" ? "company" : "person",
            }),
        },
        h,
      ),
      // Disabled controls are excluded from FormData while a save is pending.
      h.input([h.Type("hidden"), h.Name("kind"), h.Value(kind)]),
      field(
        "Display name",
        input(
          [
            h.Name("name"),
            h.Type("text"),
            h.Maxlength(personNameLimit),
            h.Readonly(pending),
          ],
          h,
        ),
        h,
      ),
      h.fieldset(
        [
          h.Id(`${options.formId}-addresses`),
          h.Class("person-value-fields"),
          h.Inert(pending),
          h.OnMount(MountContactValues({ name: "addresses", values: emails })),
        ],
        [],
      ),
      h.fieldset(
        [
          h.Id(`${options.formId}-domains`),
          h.Class("person-value-fields"),
          h.Hidden(kind !== "company"),
          h.Disabled(kind !== "company"),
          h.Inert(pending),
          h.OnMount(MountContactValues({ name: "domains", values: domains })),
        ],
        [],
      ),
      ...(person?.photo
        ? [
            h.label(
              [h.Class("person-photo-remove"), h.Inert(pending)],
              [
                h.input([h.Type("checkbox"), h.Name("removePhoto")]),
                kind === "company"
                  ? "Remove logo and use favicon"
                  : "Remove photo",
              ],
            ),
          ]
        : []),
      ...(options.heading ? [] : [Dialog.footer(actions, h)]),
    ],
  );
};

export const editForm = (
  h: HtmlBuilder<Message>,
  person: typeof Person.Type,
  pending: boolean,
  heading: string,
) =>
  profileForm(h, person, null, pending, {
    formId: editFormId,
    submit: Message.SubmittedEdit(),
    cancel: Message.CanceledEdit(),
    heading,
  });

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const { person, address } = model;
  const heading = model.creating
    ? model.kind === "company"
      ? "New company"
      : "New person"
    : person?.self || !address
      ? "Your profile"
      : model.kind === "company"
        ? "Company profile"
        : "Contact profile";
  const pending = model.saveRequest !== null;
  return Dialog.view(
    {
      model: model.dialog,
      title: heading,
      showCloseButton: false,
      content: () =>
        h.div(
          [h.Class("person-dialog-content")],
          [
            ...(model.error ? [h.p([h.Role("alert")], [model.error])] : []),
            ...(model.loadRequest
              ? [h.p([h.Role("status")], ["Loading profile…"])]
              : []),
            ...(model.ready
              ? [
                  ...(person?.managedAddresses.length
                    ? [
                        h.div(
                          [h.Class("person-managed-emails")],
                          [
                            h.strong([], ["Account addresses"]),
                            h.p([], [person.managedAddresses.join(", ")]),
                          ],
                        ),
                      ]
                    : []),
                  profileForm(h, person, address, pending, {
                    formId,
                    key: model.editorKey,
                    submit: Message.Submitted(),
                    cancel: Message.Closed(),
                    suggestedName: model.suggestedName,
                    kind: model.kind,
                    domains: model.suggestedDomains,
                  }),
                ]
              : [
                  Dialog.footer(
                    [
                      button(
                        {
                          variant: "outline",
                          size: "sm",
                          onClick: Message.Closed(),
                          children: ["Close"],
                        },
                        h,
                      ),
                      ...(!model.loadRequest
                        ? [
                            button(
                              {
                                size: "sm",
                                onClick: Message.Retried(),
                                children: ["Retry"],
                              },
                              h,
                            ),
                          ]
                        : []),
                    ],
                    h,
                  ),
                ]),
          ],
        ),
      toParentMessage: toDialogMessage,
    },
    h,
  );
});
