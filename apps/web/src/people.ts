import { Effect, Schema } from "effect";
import { Command, Submodel, Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import * as Mount from "foldkit/mount";
import {
  peopleApiPath,
  PeopleList,
  PeopleRoute,
  Person,
  personAddressLimit,
  personApiPath,
  PersonDraft,
  personLookupPath,
  PersonLookup,
  personNameLimit,
  personPhotoPath,
  type PersonSummary,
  profilePhotoSize,
  selfProfilePath,
} from "./people-contract.ts";

export const Model = Schema.Struct({
  self: Schema.NullOr(Person),
  selfRequest: Schema.NullOr(Schema.String),
  opened: Schema.Boolean,
  address: Schema.NullOr(Schema.String),
  person: Schema.NullOr(Person),
  ready: Schema.Boolean,
  loadRequest: Schema.NullOr(Schema.String),
  saveRequest: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  directory: Schema.Struct({
    selected: PeopleRoute.fields.id,
    records: Schema.NullOr(PeopleList.fields.people),
    listRequest: Schema.NullOr(Schema.String),
    listFailed: Schema.Boolean,
    edit: Schema.NullOr(Person),
    editRequest: Schema.NullOr(Schema.String),
    editError: Schema.NullOr(Schema.String),
  }),
});
type Model = typeof Model.Type;
export const initial: Model = {
  self: null,
  selfRequest: null,
  opened: false,
  address: null,
  person: null,
  ready: false,
  loadRequest: null,
  saveRequest: null,
  error: null,
  directory: {
    selected: null,
    records: null,
    listRequest: null,
    listFailed: false,
    edit: null,
    editRequest: null,
    editError: null,
  },
};

export const Message = defineMessageUnion({
  RequestedSelf: {},
  Opened: { address: Schema.NullOr(Schema.String) },
  Closed: {},
  Mounted: {},
  Retried: {},
  Loaded: { request: Schema.String, person: Schema.NullOr(Person) },
  Submitted: {},
  Saved: { request: Schema.String, person: Person },
  Failed: { request: Schema.String, error: Schema.String },
  SessionExpired: { request: Schema.String },
  VisitedDirectory: { ...PeopleRoute.fields, refresh: Schema.Boolean },
  RetriedDirectory: {},
  LoadedDirectory: { request: Schema.String, ...PeopleList.fields },
  DirectoryFailed: { request: Schema.String },
  EditedRecord: {},
  CanceledEdit: {},
  SubmittedEdit: {},
});
type Message = typeof Message.Type;

const formId = "person-profile-form";
const editFormId = "person-directory-edit";
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

const photoFor = async (file: File) => {
  if (
    file.size > 10 * 1024 * 1024 ||
    !["image/jpeg", "image/png", "image/webp"].includes(file.type)
  )
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
          addresses: String(fields.get("addresses") ?? "")
            .split(/[\n,]+/u)
            .map((part) => part.trim())
            .filter(Boolean),
          ...(person ? { revision: person.revision } : {}),
          ...(photo === undefined ? {} : { photo }),
        });
        if (decoded._tag === "None")
          return fail(
            "Enter a name and up to " +
              personAddressLimit +
              " valid email addresses.",
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

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> => {
  const directory = model.directory;
  return Message.match<Update.Return<Model, Message>>(message, {
    RequestedSelf: () => {
      if (model.selfRequest) return { model };
      const request = crypto.randomUUID();
      return {
        model: { ...model, selfRequest: request },
        commands: [Load({ request, address: null })],
      };
    },
    Opened: ({ address }) =>
      model.opened
        ? { model }
        : loadDialog({
            ...initial,
            self: model.self,
            selfRequest: model.selfRequest,
            directory,
            opened: true,
            address,
          }),
    Closed: () =>
      model.saveRequest
        ? { model }
        : {
            model: {
              ...initial,
              self: model.self,
              selfRequest: model.selfRequest,
              directory,
            },
          },
    Mounted: () => ({ model }),
    Retried: () =>
      model.opened && !model.loadRequest ? loadDialog(model) : { model },
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
          self: person?.self ? person : model.self,
        },
      };
    },
    Submitted: () => {
      if (!model.ready || !model.opened || model.saveRequest) return { model };
      const request = crypto.randomUUID();
      return {
        model: { ...model, saveRequest: request, error: null },
        commands: [Save({ request, person: model.person, formId })],
      };
    },
    Saved: ({ request, person }) => {
      const editing = request === directory.editRequest;
      if (!editing && request !== model.saveRequest) return { model };
      const records = directory.records
        ? [...directory.records.filter(({ id }) => id !== person.id), person]
        : null;
      return {
        model: {
          ...(editing ? model : initial),
          self: person.self ? person : model.self,
          selfRequest: person.self ? null : model.selfRequest,
          directory: {
            ...directory,
            records,
            listRequest: records ? null : directory.listRequest,
            ...(editing
              ? { edit: null, editRequest: null, editError: null }
              : {}),
          },
        },
      };
    },
    Failed: ({ request, error }) => {
      if (request === directory.editRequest)
        return {
          model: {
            ...model,
            directory: {
              ...directory,
              editRequest: null,
              editError: directory.edit ? error : null,
            },
          },
        };
      if (request === model.selfRequest)
        return { model: { ...model, selfRequest: null } };
      if (request !== model.loadRequest && request !== model.saveRequest)
        return { model };
      return {
        model: { ...model, error, loadRequest: null, saveRequest: null },
      };
    },
    SessionExpired: () => ({ model }),
    VisitedDirectory: ({ id, refresh }) => {
      const next = {
        ...model,
        directory: { ...directory, selected: id, edit: null, editError: null },
      };
      return refresh || directory.records === null
        ? loadDirectory(next)
        : { model: next };
    },
    RetriedDirectory: () => loadDirectory(model),
    LoadedDirectory: ({ request, people }) =>
      request !== directory.listRequest
        ? { model }
        : {
            model: {
              ...model,
              directory: { ...directory, records: people, listRequest: null },
            },
          },
    DirectoryFailed: ({ request }) =>
      request !== directory.listRequest
        ? { model }
        : {
            model: {
              ...model,
              directory: { ...directory, listRequest: null, listFailed: true },
            },
          },
    EditedRecord: () => {
      const edit = directory.records?.find(
        ({ id }) => id === directory.selected,
      );
      if (
        !edit ||
        directory.edit ||
        directory.editRequest ||
        directory.listRequest
      )
        return { model };
      return {
        model: { ...model, directory: { ...directory, edit, editError: null } },
      };
    },
    CanceledEdit: () =>
      directory.editRequest
        ? { model }
        : {
            model: {
              ...model,
              directory: { ...directory, edit: null, editError: null },
            },
          },
    SubmittedEdit: () => {
      if (!directory.edit || directory.editRequest) return { model };
      const request = crypto.randomUUID();
      return {
        model: {
          ...model,
          directory: { ...directory, editRequest: request, editError: null },
        },
        commands: [
          Save({ request, person: directory.edit, formId: editFormId }),
        ],
      };
    },
  });
};

const OpenDialog = Mount.define("OpenPersonProfileDialog", {
  messages: [Message.Mounted],
  execute: ({ element }) =>
    Effect.sync(() => {
      if (element instanceof HTMLDialogElement && !element.open)
        element.showModal();
      return Message.Mounted();
    }),
});

const PrepareForm = Mount.define("PrefillPersonProfileForm", {
  args: { name: Schema.String, addresses: Schema.String },
  messages: [Message.Mounted],
  execute: ({ element, name, addresses }) =>
    Effect.sync(() => {
      if (element instanceof HTMLFormElement) {
        const nameField = element.elements.namedItem("name");
        const addressField = element.elements.namedItem("addresses");
        if (nameField instanceof HTMLInputElement) nameField.value = name;
        if (addressField instanceof HTMLTextAreaElement)
          addressField.value = addresses;
      }
      return Message.Mounted();
    }),
});

export const avatar = <Message>(
  h: HtmlBuilder<Message>,
  person: PersonSummary | null | undefined,
  address: string,
  suggestedName?: string,
) => {
  const letters =
    (person?.name || suggestedName || address.split("@", 1)[0] || "").match(
      /[\p{L}\p{N}]+/gu,
    ) ?? [];
  const initials =
    letters
      .slice(0, 2)
      .map((word) => Array.from(word)[0])
      .join("")
      .toLocaleUpperCase() || "?";
  return h.span(
    [h.Class("person-avatar"), h.AriaHidden(true)],
    [
      person?.photo
        ? h.img([h.Src(personPhotoPath(person.id, person.photo)), h.Alt("")])
        : initials,
    ],
  );
};

const profileForm = (
  h: HtmlBuilder<Message>,
  person: typeof Person.Type | null,
  address: string | null,
  pending: boolean,
  options: { formId: string; submit: Message; cancel: Message },
) => {
  const emails = person?.addresses ?? (address ? [address] : []);
  return h.form(
    [
      h.Id(options.formId),
      h.Class("person-fields"),
      h.OnSubmit(options.submit),
      h.OnMount(
        PrepareForm({
          name: person?.name ?? "",
          addresses: emails.join("\n"),
        }),
      ),
    ],
    [
      h.label(
        [],
        [
          "Display name",
          h.input([
            h.Name("name"),
            h.Type("text"),
            h.Maxlength(personNameLimit),
            h.Readonly(pending),
          ]),
        ],
      ),
      h.label(
        [],
        [
          "Email addresses",
          h.textarea([
            h.Name("addresses"),
            h.Rows(3),
            h.Readonly(pending),
            h.Placeholder("One address per line"),
          ]),
        ],
      ),
      h.label(
        [],
        [
          "Profile photo",
          h.input([
            h.Name("photo"),
            h.Type("file"),
            h.Accept("image/jpeg,image/png,image/webp"),
          ]),
        ],
      ),
      ...(person?.photo
        ? [
            h.label(
              [h.Class("person-photo-remove")],
              [
                h.input([h.Type("checkbox"), h.Name("removePhoto")]),
                "Remove photo",
              ],
            ),
          ]
        : []),
      h.div(
        [h.Class("person-actions")],
        [
          h.button(
            [h.Type("button"), h.Disabled(pending), h.OnClick(options.cancel)],
            ["Cancel"],
          ),
          h.button(
            [h.Type("submit"), h.Disabled(pending)],
            [pending ? "Saving…" : "Save"],
          ),
        ],
      ),
    ],
  );
};

export const editForm = (
  h: HtmlBuilder<Message>,
  person: typeof Person.Type,
  pending: boolean,
) =>
  profileForm(h, person, null, pending, {
    formId: editFormId,
    submit: Message.SubmittedEdit(),
    cancel: Message.CanceledEdit(),
  });

export const view = Submodel.defineView<Model, Message>((model, h) => {
  if (!model.opened) return h.div([], []);
  const { person, address } = model;
  const heading = person?.self || !address ? "Your profile" : "Person profile";
  const pending = model.saveRequest !== null;
  return h.dialog(
    [
      h.Class("person-dialog"),
      h.AriaLabelledBy("person-dialog-title"),
      h.OnMount(OpenDialog()),
      h.OnCancel(Message.Closed()),
    ],
    [
      h.h2([h.Id("person-dialog-title")], [heading]),
      ...(model.error ? [h.p([h.Role("alert")], [model.error])] : []),
      ...(model.loadRequest
        ? [h.p([h.Role("status")], ["Loading profile…"])]
        : []),
      ...(!model.ready
        ? [
            h.div(
              [h.Class("person-actions")],
              [
                h.button(
                  [h.Type("button"), h.OnClick(Message.Closed())],
                  ["Close"],
                ),
                ...(!model.loadRequest
                  ? [
                      h.button(
                        [h.Type("button"), h.OnClick(Message.Retried())],
                        ["Retry"],
                      ),
                    ]
                  : []),
              ],
            ),
          ]
        : [
            h.div(
              [h.Class("person-photo-preview")],
              [avatar(h, person, address ?? person?.managedAddresses[0] ?? "")],
            ),
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
              submit: Message.Submitted(),
              cancel: Message.Closed(),
            }),
          ]),
    ],
  );
});
