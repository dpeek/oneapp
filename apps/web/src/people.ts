import {
  avatar as uiAvatar,
  button,
  buttonGroup,
  dialog,
  field,
  input,
  nativeSelect,
} from "@oneapp/ui";
import { Effect, Schema } from "effect";
import { Command, Submodel, Update } from "foldkit";
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
  Person,
  personAddressLimit,
  personApiPath,
  PersonDraft,
  PersonId,
  personLookupPath,
  PersonLookup,
  personNameLimit,
  contactPath,
  type PersonSummary,
  profilePhotoSize,
  selfProfilePath,
} from "./people-contract.ts";

import { contactImage } from "./contact-image.ts";
import { Notification } from "./notifications.ts";
import { normalizeCompanyDomain } from "./company-domains.ts";

export const Model = Schema.Struct({
  self: Schema.NullOr(Person),
  selfRequest: Schema.NullOr(Schema.String),
  opened: Schema.Boolean,
  address: Schema.NullOr(Schema.String),
  suggestedName: Schema.String,
  kind: ContactKind,
  suggestedDomains: Schema.Array(Schema.String),
  companySuggestion: Schema.NullOr(Person),
  creating: Schema.Boolean,
  person: Schema.NullOr(Person),
  ready: Schema.Boolean,
  loadRequest: Schema.NullOr(Schema.String),
  saveRequest: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  directory: Schema.Struct({
    selected: ContactsRoute.fields.id,
    records: Schema.NullOr(PeopleList.fields.people),
    listRequest: Schema.NullOr(Schema.String),
    listFailed: Schema.Boolean,
    edit: Schema.NullOr(Person),
    editRequest: Schema.NullOr(Schema.String),
    editTarget: Schema.NullOr(Person),
    editError: Schema.NullOr(Schema.String),
  }),
});
type Model = typeof Model.Type;
export const initial: Model = {
  self: null,
  selfRequest: null,
  opened: false,
  address: null,
  suggestedName: "",
  kind: "person",
  suggestedDomains: [],
  companySuggestion: null,
  creating: false,
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
    editTarget: null,
    editError: null,
  },
};

export const Message = defineMessageUnion({
  RequestedSelf: {},
  Opened: {
    address: Schema.NullOr(Schema.String),
    suggestedName: Schema.optionalKey(Schema.String),
    suggestedKind: Schema.optionalKey(ContactKind),
    suggestedDomain: Schema.optionalKey(Schema.String),
  },
  Created: { kind: ContactKind },
  ChangedKind: { kind: ContactKind },
  UsedCompanySuggestion: {},
  Closed: {},
  Mounted: {},
  Retried: {},
  Loaded: {
    request: Schema.String,
    person: Schema.NullOr(Person),
    companySuggestion: Schema.optionalKey(Schema.NullOr(Person)),
  },
  Submitted: {},
  Saved: { request: Schema.String, person: Person },
  Failed: { request: Schema.String, error: Schema.String },
  SessionExpired: { request: Schema.String },
  VisitedDirectory: { ...ContactsRoute.fields, refresh: Schema.Boolean },
  RetriedDirectory: {},
  LoadedDirectory: { request: Schema.String, ...PeopleList.fields },
  DirectoryFailed: { request: Schema.String },
  EditedRecord: {},
  CanceledEdit: {},
  SubmittedEdit: {},
});
type Message = typeof Message.Type;
export const OutMessage = defineMessageUnion({
  Notify: { notification: Notification },
  DismissNotification: { key: Schema.String },
});
export type OutMessage = typeof OutMessage.Type;
const notificationKey = (id: string) => `contact-save:${id}`;

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
      const companySuggestion = address
        ? Schema.decodeUnknownSync(PersonLookup)(value).companySuggestion
        : undefined;
      return Message.Loaded({
        request,
        person,
        ...(companySuggestion ? { companySuggestion } : {}),
      });
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

const FocusDirectory = Command.define("FocusPeopleDirectory", {
  args: { id: PersonId },
  messages: [Message.Mounted],
  execute: ({ id }) => {
    const list = ".people-workspace:not([data-panel]) .people-list";
    return focus(`${list} [href="${contactPath(id)}"]`, {
      preventScroll: true,
    }).pipe(
      Effect.catch(() => focus(list, { preventScroll: true })),
      Effect.ignore,
      Effect.as(Message.Mounted()),
    );
  },
});

const photoTypes = ["image/jpeg", "image/png", "image/webp"];
const isProfilePhoto = (file: File) =>
  file.size <= 10 * 1024 * 1024 && photoTypes.includes(file.type);

const photoFor = async (file: File, company: boolean) => {
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
    if (company) {
      const scale = Math.min(
        canvas.width / source.width,
        canvas.height / source.height,
      );
      const width = source.width * scale,
        height = source.height * scale;
      context.drawImage(
        source,
        (canvas.width - width) / 2,
        (canvas.height - height) / 2,
        width,
        height,
      );
    } else {
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
    }
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
            photo = await photoFor(file, kind === "company");
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
  directoryVisible = true,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> => {
  const directory = model.directory;
  return Message.match<Update.ReturnWithOutMessage<Model, Message, OutMessage>>(
    message,
    {
      RequestedSelf: () => {
        if (model.selfRequest) return { model };
        const request = crypto.randomUUID();
        return {
          model: { ...model, selfRequest: request },
          commands: [Load({ request, address: null })],
        };
      },
      Created: ({ kind }) =>
        model.opened
          ? { model }
          : {
              model: {
                ...model,
                opened: true,
                creating: true,
                ready: true,
                address: null,
                person: null,
                kind,
                suggestedDomains: [],
                suggestedName: "",
                companySuggestion: null,
                loadRequest: null,
                error: null,
              },
            },
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
      UsedCompanySuggestion: () => {
        if (!model.companySuggestion || model.saveRequest || !model.address)
          return { model };
        return {
          model: {
            ...model,
            kind: "company",
            person: {
              ...model.companySuggestion,
              addresses: [
                ...new Set([
                  ...model.companySuggestion.addresses,
                  model.address,
                ]),
              ],
            },
            companySuggestion: null,
          },
        };
      },
      Opened: ({ address, suggestedName, suggestedKind, suggestedDomain }) =>
        model.opened
          ? { model }
          : loadDialog({
              ...initial,
              self: model.self,
              selfRequest: model.selfRequest,
              directory,
              opened: true,
              address,
              kind: suggestedKind ?? "person",
              suggestedDomains: suggestedDomain ? [suggestedDomain] : [],
              suggestedName:
                suggestedName
                  ?.trim()
                  .slice(0, personNameLimit)
                  .replace(/[\uD800-\uDBFF]$/u, "") ?? "",
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
      Loaded: ({ request, person, companySuggestion }) => {
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
            companySuggestion: companySuggestion ?? null,
            self: person?.self ? person : model.self,
          },
        };
      },
      Submitted: () => {
        if (!model.ready || !model.opened || model.saveRequest)
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
        return {
          outMessage: OutMessage.DismissNotification({
            key: notificationKey(person.id),
          }),
          model: {
            ...(editing ? model : initial),
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
          },
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
        const next = {
          ...model,
          directory: {
            ...directory,
            selected: id,
            edit: null,
            editError: null,
          },
        };
        const result =
          refresh || directory.records === null
            ? loadDirectory(next)
            : { model: next };
        return id === null && directory.selected && !refresh
          ? {
              ...result,
              commands: [
                ...(result.commands ?? []),
                FocusDirectory({ id: directory.selected }),
              ],
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
                directory: { ...directory, records: people, listRequest: null },
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
          model: {
            ...model,
            directory: { ...directory, edit, editError: null },
          },
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
    },
  );
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
        // Canceling the file picker should keep the profile dialog open.
        const cancel = (event: Event) => event.stopPropagation();
        input.addEventListener("change", select);
        input.addEventListener("cancel", cancel);
        preview.addEventListener("load", reveal);
        return () => {
          input.removeEventListener("change", select);
          input.removeEventListener("cancel", cancel);
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
    size?: "lg";
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
      fit: (options.kind ?? person?.kind) === "company" ? undefined : "cover",
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
        children: [pending ? "Saving…" : "Save"],
      },
      h,
    ),
  ];
  return h.form(
    [
      h.Id(options.formId),
      h.Key(`${options.formId}-${person?.id ?? "new"}`),
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
      ...(options.heading ? [] : [h.div([h.Class("person-actions")], actions)]),
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
  if (!model.opened) return h.div([], []);
  const { person, address } = model;
  const heading = model.creating
    ? "New contact"
    : person?.self || !address
      ? "Your profile"
      : model.kind === "company"
        ? "Company profile"
        : "Contact profile";
  const pending = model.saveRequest !== null;
  return dialog(
    {
      title: heading,
      titleId: "person-dialog-title",
      attributes: [h.OnMount(OpenDialog()), h.OnCancel(Message.Closed())],
      children: [
        ...(model.error ? [h.p([h.Role("alert")], [model.error])] : []),
        ...(model.loadRequest
          ? [h.p([h.Role("status")], ["Loading profile…"])]
          : []),
        ...(!model.ready
          ? [
              h.div(
                [h.Class("person-actions")],
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
              ),
            ]
          : [
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
              ...(!person && model.companySuggestion
                ? [
                    h.div(
                      [h.Class("company-suggestion")],
                      [
                        h.p(
                          [],
                          [
                            `This address matches ${model.companySuggestion.name}.`,
                          ],
                        ),
                        button(
                          {
                            type: "button",
                            disabled: pending,
                            onClick: Message.UsedCompanySuggestion(),
                            children: ["Add address to this company"],
                          },
                          h,
                        ),
                      ],
                    ),
                  ]
                : []),
              profileForm(h, person, address, pending, {
                formId,
                submit: Message.Submitted(),
                cancel: Message.Closed(),
                suggestedName: model.suggestedName,
                kind: model.kind,
                domains: model.suggestedDomains,
              }),
            ]),
      ],
    },
    h,
  );
});
