import {
  button,
  field,
  input,
  item,
  itemGroup,
  nativeSelect,
  outlineIcon,
  plusIcon,
  spinner,
  trashIconPaths,
} from "@orumai/ui";
import { Effect, Option, Schema } from "effect";
import { Command, Render, Submodel, Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { mailPath } from "./inbox-contract.ts";
import {
  exactInboundAddress,
  InboundRoute,
  inboundRoutesApiPath,
  Mailbox,
  Mailboxes,
  mailboxesApiPath,
  mailboxUrl,
  MailSettings,
  mailSettingsApiPath,
  NewMailbox,
} from "./mail-settings-contract.ts";

const Operation = Schema.Union([
  Schema.TaggedStruct("Load", {}),
  Schema.TaggedStruct("LoadMailboxes", {}),
  Schema.TaggedStruct("CreateMailbox", NewMailbox.fields),
  Schema.TaggedStruct("SaveRoute", {
    route: InboundRoute,
    previous: Schema.NullOr(InboundRoute),
  }),
  Schema.TaggedStruct("DeleteRoute", { route: InboundRoute }),
]);
type Operation = typeof Operation.Type;
const SettingsOperation = Schema.Literals([
  "Load",
  "LoadMailboxes",
  "CreateMailbox",
]);
type SettingsOperation = typeof SettingsOperation.Type;

const RouteFields = Schema.Struct({
  name: Schema.String,
  domain: Schema.String,
  mailboxId: Schema.String,
});
type RouteFields = typeof RouteFields.Type;

const Row = Schema.Struct({
  id: Schema.String,
  fields: RouteFields,
  saved: Schema.NullOr(InboundRoute),
  pending: Schema.NullOr(
    Schema.Struct({
      request: Schema.String,
      // The route being saved, or null while deleting.
      route: Schema.NullOr(InboundRoute),
    }),
  ),
  queued: Schema.NullOr(Schema.Union([RouteFields, Schema.Literal("Delete")])),
  attempted: Schema.Boolean,
  error: Schema.String,
});
type Row = typeof Row.Type;

const routeFields = (route: InboundRoute): RouteFields => {
  const [name = "", domain = ""] = route.address.split("@");
  return { name, domain, mailboxId: route.mailboxId };
};

const newRow = (saved: InboundRoute | null): Row => ({
  id: crypto.randomUUID(),
  fields: saved ? routeFields(saved) : { name: "", domain: "", mailboxId: "" },
  saved,
  pending: null,
  queued: null,
  attempted: false,
  error: "",
});

const { routes: _routes, ...settingsFields } = MailSettings.fields;
export const Model = Schema.Struct({
  data: Schema.NullOr(Schema.Struct(settingsFields)),
  mailboxes: Schema.NullOr(Mailboxes.fields.mailboxes),
  name: Schema.String,
  rows: Schema.Array(Row),
  request: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      operation: SettingsOperation,
    }),
  ),
  error: Schema.String,
  status: Schema.String,
});
type Model = typeof Model.Type;

export const initial: Model = {
  data: null,
  mailboxes: null,
  name: "",
  rows: [],
  request: null,
  error: "",
  status: "",
};

export const Message = defineMessageUnion({
  Requested: {},
  RequestedMailboxes: {},
  ChangedName: { name: Schema.String },
  CreatedMailbox: {},
  AddedRow: {},
  ChangedField: {
    id: Schema.String,
    field: Schema.Literals(["name", "domain", "mailboxId"]),
    value: Schema.String,
  },
  CommittedRow: { id: Schema.String },
  RemovedRow: { id: Schema.String },
  Ignored: {},
  Loaded: { request: Schema.String, data: MailSettings },
  LoadedMailboxes: { request: Schema.String, data: Mailboxes },
  SavedMailbox: { request: Schema.String, mailbox: Mailbox },
  SavedRoute: { request: Schema.String, route: InboundRoute },
  DeletedRoute: { request: Schema.String },
  Failed: { request: Schema.String, error: Schema.String },
  SessionExpired: { request: Schema.String },
});
type Message = typeof Message.Type;

const addRuleId = "add-inbound-address-rule";
const rowNameId = (id: string) => `inbound-address-name-${id}`;
const rowDeleteId = (id: string) => `delete-inbound-address-rule-${id}`;

const FocusRow = Command.define("FocusInboundRule", {
  args: { id: Schema.String, removedId: Schema.NullOr(Schema.String) },
  messages: [Message.Ignored],
  execute: ({ id, removedId }) =>
    Render.afterCommit.pipe(
      Effect.andThen(
        Effect.sync(() => {
          const active = document.activeElement;
          if (
            removedId === null ||
            active === document.body ||
            active?.id === removedId
          )
            document.getElementById(id)?.focus();
          return Message.Ignored();
        }),
      ),
    ),
});

const Request = Command.define("RequestMailSettings", {
  args: { request: Schema.String, operation: Operation },
  messages: [
    Message.Loaded,
    Message.LoadedMailboxes,
    Message.SavedMailbox,
    Message.SavedRoute,
    Message.DeletedRoute,
    Message.Failed,
    Message.SessionExpired,
  ],
  execute: ({ request, operation }) => {
    const failed = (error: string) => Message.Failed({ request, error });
    return Effect.tryPromise(async (signal) => {
      const [resource, method, payload] = (() => {
        switch (operation._tag) {
          case "Load":
            return [mailSettingsApiPath, "GET", null] as const;
          case "LoadMailboxes":
            return [mailboxesApiPath, "GET", null] as const;
          case "CreateMailbox":
            return [
              mailboxesApiPath,
              "POST",
              { name: operation.name },
            ] as const;
          case "SaveRoute":
            return operation.previous
              ? ([
                  inboundRoutesApiPath,
                  "PUT",
                  { previous: operation.previous, route: operation.route },
                ] as const)
              : ([inboundRoutesApiPath, "POST", operation.route] as const);
          case "DeleteRoute":
            return [inboundRoutesApiPath, "DELETE", operation.route] as const;
        }
      })();
      const response = await fetch(resource, {
        signal,
        cache: "no-store",
        method,
        ...(payload
          ? {
              headers: {
                "content-type": "application/json",
                "x-effect-auth-csrf": "1",
              },
              body: JSON.stringify(payload),
            }
          : {}),
      });
      if (response.status === 401) return Message.SessionExpired({ request });
      if (!response.ok) {
        const problem = await response.json().catch(() => null);
        return failed(
          typeof problem?.error === "string"
            ? problem.error
            : "Could not complete the Mail settings request. Try again.",
        );
      }
      if (operation._tag === "DeleteRoute")
        return Message.DeletedRoute({ request });
      const data: unknown = await response.json();
      switch (operation._tag) {
        case "Load":
          return Message.Loaded({
            request,
            data: Schema.decodeUnknownSync(MailSettings)(data),
          });
        case "LoadMailboxes":
          return Message.LoadedMailboxes({
            request,
            data: Schema.decodeUnknownSync(Mailboxes)(data),
          });
        case "CreateMailbox":
          return Message.SavedMailbox({
            request,
            mailbox: Schema.decodeUnknownSync(Mailbox)(data),
          });
        case "SaveRoute":
          return Message.SavedRoute({
            request,
            route: Schema.decodeUnknownSync(InboundRoute)(data),
          });
      }
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          failed("Could not complete the Mail settings request. Try again."),
        ),
      ),
    );
  },
});

const start = (
  model: Model,
  operation: Extract<Operation, { _tag: SettingsOperation }>,
): Update.Return<Model, Message> => {
  const request = crypto.randomUUID();
  return {
    model: {
      ...model,
      request: { id: request, operation: operation._tag },
      error: "",
      status: "",
    },
    commands: [Request({ request, operation })],
  };
};

export const isCurrentRequest = (model: Model, request: string) =>
  model.request?.id === request ||
  model.rows.some((row) => row.pending?.request === request);

const withRow = (model: Model, row: Row): Model => ({
  ...model,
  rows: model.rows.map((entry) => (entry.id === row.id ? row : entry)),
});

const validate = (model: Model, id: string, fields: RouteFields) => {
  const { name, domain, mailboxId } = fields;
  const domainValid = model.data?.domains.some((option) => option === domain);
  const mailboxValid = model.data?.destinations.some(
    ({ id }) => id === mailboxId,
  );
  const address = exactInboundAddress(
    name,
    domainValid ? domain : (model.data?.domains[0] ?? ""),
  );
  const duplicate =
    domainValid &&
    model.rows.some(
      (other) => other.id !== id && other.saved?.address === address,
    );
  return {
    route:
      address && domainValid && !duplicate && mailboxValid
        ? { address, mailboxId }
        : null,
    errors: {
      name: !name.trim()
        ? "Enter an address name."
        : !address
          ? "Enter a valid address name without @ or wildcards."
          : duplicate
            ? "That address already has a rule."
            : "",
      domain: domainValid ? "" : "Select a receiving domain.",
      mailboxId: mailboxValid ? "" : "Select a target mailbox.",
    },
  };
};

const sameRoute = (saved: InboundRoute | null, route: InboundRoute) =>
  saved?.address === route.address && saved.mailboxId === route.mailboxId;

const commit = (
  model: Model,
  row: Row,
  fields = row.fields,
): Update.Return<Model, Message> => {
  if (row.pending?.route === null || row.queued === "Delete") return { model };
  const { route } = validate(model, row.id, fields);
  const attempted = { ...row, attempted: true };
  if (row.pending) {
    const queued =
      route && !sameRoute(row.pending.route, route) ? fields : null;
    return { model: withRow(model, { ...attempted, queued }) };
  }
  if (!route || sameRoute(row.saved, route))
    return { model: withRow(model, attempted) };
  const request = crypto.randomUUID();
  return {
    model: withRow(
      { ...model, status: "" },
      { ...attempted, pending: { request, route }, error: "" },
    ),
    commands: [
      Request({
        request,
        operation: { _tag: "SaveRoute", route, previous: row.saved },
      }),
    ],
  };
};

const removeRow = (model: Model, row: Row): Update.Return<Model, Message> => {
  const index = model.rows.indexOf(row);
  const neighbor = model.rows[index + 1] ?? model.rows[index - 1];
  return {
    model: { ...model, rows: model.rows.filter(({ id }) => id !== row.id) },
    commands: [
      FocusRow({
        id: neighbor ? rowDeleteId(neighbor.id) : addRuleId,
        removedId: rowDeleteId(row.id),
      }),
    ],
  };
};

const deleteRule = (model: Model, row: Row): Update.Return<Model, Message> => {
  if (row.pending) {
    return row.pending.route
      ? { model: withRow(model, { ...row, queued: "Delete" }) }
      : { model };
  }
  if (!row.saved) return removeRow(model, row);
  const request = crypto.randomUUID();
  return {
    model: withRow(
      { ...model, status: "" },
      { ...row, pending: { request, route: null }, error: "" },
    ),
    commands: [
      Request({
        request,
        operation: { _tag: "DeleteRoute", route: row.saved },
      }),
    ],
  };
};

const continueRow = (model: Model, row: Row): Update.Return<Model, Message> => {
  const { queued } = row;
  const next = { ...row, pending: null, queued: null };
  const updated = withRow(model, next);
  if (queued === "Delete") return deleteRule(updated, next);
  if (queued) return commit(updated, next, queued);
  return { model: updated };
};

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> => {
  if ("request" in message && !isCurrentRequest(model, message.request))
    return { model };
  const row =
    "id" in message
      ? model.rows.find(({ id }) => id === message.id)
      : "request" in message
        ? model.rows.find(({ pending }) => pending?.request === message.request)
        : undefined;

  return Message.match<Update.Return<Model, Message>>(message, {
    Requested: () =>
      (model.request && model.request.operation !== "LoadMailboxes") ||
      model.rows.some(({ pending }) => pending)
        ? { model }
        : start({ ...model, data: null, rows: [] }, { _tag: "Load" }),
    RequestedMailboxes: () =>
      model.request ? { model } : start(model, { _tag: "LoadMailboxes" }),
    ChangedName: ({ name }) => ({ model: { ...model, name } }),
    CreatedMailbox: () => {
      if (model.request) return { model };
      const mailbox = Schema.decodeUnknownOption(NewMailbox)({
        name: model.name,
      });
      return mailbox._tag === "Some"
        ? start(model, { _tag: "CreateMailbox", ...mailbox.value })
        : {
            model: {
              ...model,
              error: "Enter a mailbox name of 1 to 100 characters.",
            },
          };
    },
    AddedRow: () => {
      const draft = newRow(null);
      return {
        model: { ...model, rows: [...model.rows, draft] },
        commands: [FocusRow({ id: rowNameId(draft.id), removedId: null })],
      };
    },
    ChangedField: ({ field, value }) => {
      if (!row || row.pending?.route === null || row.queued === "Delete")
        return { model };
      const next = {
        ...row,
        fields: { ...row.fields, [field]: value },
        error: "",
      };
      const updated = withRow(model, next);
      return field === "name" ? { model: updated } : commit(updated, next);
    },
    CommittedRow: () => (row ? commit(model, row) : { model }),
    RemovedRow: () => (row ? deleteRule(model, row) : { model }),
    Ignored: () => ({ model }),
    Loaded: ({ data: { routes, ...data } }) => ({
      model: {
        ...model,
        data,
        rows: routes.map(newRow),
        mailboxes: data.mailboxes,
        request: null,
      },
    }),
    LoadedMailboxes: ({ data }) => ({
      model: { ...model, mailboxes: data.mailboxes, request: null },
    }),
    SavedMailbox: ({ mailbox }) => {
      const mailboxes = [...(model.mailboxes ?? []), mailbox];
      return {
        model: {
          ...model,
          mailboxes,
          data: model.data && {
            ...model.data,
            mailboxes,
            destinations: [...model.data.destinations, mailbox],
          },
          request: null,
          name: "",
          status: `Created mailbox ${mailbox.name}.`,
        },
      };
    },
    SavedRoute: ({ route }) =>
      row
        ? continueRow(
            { ...model, status: `Saved rule for ${route.address}.` },
            { ...row, saved: route },
          )
        : { model },
    DeletedRoute: () =>
      row
        ? removeRow(
            { ...model, status: `Deleted rule for ${row.saved?.address}.` },
            row,
          )
        : { model },
    Failed: ({ error }) =>
      row
        ? continueRow(model, {
            ...row,
            queued: row.queued === "Delete" && !row.saved ? null : row.queued,
            error,
          })
        : { model: { ...model, request: null, error } },
    SessionExpired: () => ({ model: initial }),
  });
};

const routeRow = (
  model: Model,
  row: Row,
  domains: readonly { value: string; label: string }[],
  destinations: readonly { value: string; label: string }[],
  h: HtmlBuilder<Message>,
) => {
  const { id, fields } = row;
  const { errors } = validate(model, id, fields);
  const deleting = row.pending?.route === null || row.queued === "Delete";
  const commit = Message.CommittedRow({ id });
  const changed = (field: keyof RouteFields) => (value: string) =>
    Message.ChangedField({ id, field, value });
  const saveErrorId = `inbound-rule-error-${id}`;
  const errorFor = (field: keyof RouteFields) =>
    row.attempted ? errors[field] : "";
  const errorId = (field: keyof RouteFields) => `${saveErrorId}-${field}`;
  const attributes = (field: keyof RouteFields) => {
    const invalid = !!errorFor(field);
    const descriptions = [
      ...(invalid ? [errorId(field)] : []),
      ...(row.error ? [saveErrorId] : []),
    ];
    return [
      h.OnBlur(commit),
      ...(invalid ? [h.AriaInvalid(true)] : []),
      ...(descriptions.length
        ? [h.AriaDescribedBy(descriptions.join(" "))]
        : []),
    ];
  };
  const fieldError = (field: keyof RouteFields) => {
    const error = errorFor(field);
    return error
      ? [
          h.p(
            [
              h.Id(errorId(field)),
              h.Role("status"),
              h.Class("settings-mail-error"),
            ],
            [error],
          ),
        ]
      : [];
  };
  const selectCell = (
    label: string,
    field: "domain" | "mailboxId",
    options: typeof domains,
  ) =>
    h.td(
      [],
      [
        nativeSelect(
          {
            label,
            showLabel: false,
            options,
            value: fields[field],
            disabled: deleting,
            attributes: [
              ...attributes(field),
              h.OnKeyDown((key) =>
                key === "Enter" ? commit : Message.Ignored(),
              ),
            ],
            onChange: changed(field),
          },
          h,
        ),
        ...fieldError(field),
      ],
    );
  const address = row.saved?.address;
  return [
    h.tr(
      [h.Key(id)],
      [
        h.td(
          [],
          [
            input(
              [
                h.Id(rowNameId(id)),
                h.AriaLabel("Address name"),
                h.Value(fields.name),
                h.Placeholder("e.g. support"),
                h.Readonly(deleting),
                h.Autocomplete("off"),
                h.Spellcheck(false),
                h.OnInput(changed("name")),
                h.OnKeyDownPreventDefault((key) =>
                  key === "Enter" ? Option.some(commit) : Option.none(),
                ),
                ...attributes("name"),
              ],
              h,
            ),
            ...fieldError("name"),
          ],
        ),
        selectCell("Receiving domain", "domain", domains),
        selectCell("Target mailbox", "mailboxId", destinations),
        h.td(
          [],
          [
            button(
              {
                ariaLabel: address
                  ? `Delete rule for ${address}`
                  : "Discard draft rule",
                size: "icon-sm",
                variant: "ghost",
                attributes: [h.Id(rowDeleteId(id))],
                disabled: deleting,
                focusableWhenDisabled: true,
                onClick: Message.RemovedRow({ id }),
                children: [outlineIcon(h, trashIconPaths)],
              },
              h,
            ),
          ],
        ),
      ],
    ),
    ...(row.error
      ? [
          h.tr(
            [h.Key(saveErrorId)],
            [
              h.td(
                [h.Colspan(4)],
                [
                  h.p(
                    [
                      h.Id(saveErrorId),
                      h.Role("alert"),
                      h.Class("settings-mail-error"),
                    ],
                    [row.error],
                  ),
                ],
              ),
            ],
          ),
        ]
      : []),
  ];
};

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const { data } = model;
  if (!data)
    return model.error
      ? h.div(
          [],
          [
            h.p([h.Role("alert")], [model.error]),
            button({ onClick: Message.Requested(), children: ["Retry"] }, h),
          ],
        )
      : spinner("Loading Mail settings…", h);

  const domains = [
    { value: "", label: "Choose a domain" },
    ...data.domains.map((domain) => ({ value: domain, label: domain })),
  ];
  const destinations = [
    { value: "", label: "Choose a mailbox" },
    ...data.destinations.map(({ id, name }) => ({
      value: id,
      label:
        data.destinations.filter((mailbox) => mailbox.name === name).length > 1
          ? `${name} (${id.slice(0, 8)})`
          : name,
    })),
  ];
  return h.div(
    [h.Class("settings-mail")],
    [
      h.section(
        [h.Class("settings-section"), h.AriaLabelledBy("mail-settings-boxes")],
        [
          h.h2([h.Id("mail-settings-boxes")], ["Your mailboxes"]),
          ...(data.mailboxes.length
            ? [
                itemGroup(
                  data.mailboxes.map(({ id, name }) =>
                    item(
                      {
                        key: id,
                        title: name,
                        href: mailboxUrl(mailPath, id),
                        linkTitleOnly: true,
                      },
                      h,
                    ),
                  ),
                  h,
                ),
              ]
            : []),
          h.form(
            [
              h.Class("settings-tag-form"),
              h.OnSubmit(Message.CreatedMailbox()),
            ],
            [
              field(
                "Mailbox name",
                input(
                  [
                    h.Required(true),
                    h.Maxlength(100),
                    h.Value(model.name),
                    h.Disabled(model.request !== null),
                    h.OnInput((name) => Message.ChangedName({ name })),
                  ],
                  h,
                ),
                h,
              ),
              button(
                {
                  type: "submit",
                  disabled: model.request !== null,
                  children: ["Create mailbox"],
                },
                h,
              ),
            ],
          ),
        ],
      ),
      h.section(
        [h.Class("settings-section"), h.AriaLabelledBy("mail-settings-rules")],
        [
          h.div(
            [h.Class("settings-mail-rules-header")],
            [
              h.h2([h.Id("mail-settings-rules")], ["Inbound address rules"]),
              button(
                {
                  size: "sm",
                  attributes: [h.Id(addRuleId)],
                  onClick: Message.AddedRow(),
                  children: [plusIcon(h, "1rem"), "Add inbound address rule"],
                },
                h,
              ),
            ],
          ),
          h.div(
            [h.Class("settings-mail-table-wrapper")],
            [
              h.table(
                [
                  h.AriaLabelledBy("mail-settings-rules"),
                  h.Class("settings-mail-table"),
                ],
                [
                  h.thead(
                    [],
                    [
                      h.tr(
                        [],
                        [
                          ...[
                            "Address name",
                            "Receiving domain",
                            "Target mailbox",
                          ].map((label) => h.th([h.Scope("col")], [label])),
                          h.th([h.Scope("col"), h.AriaLabel("Actions")], []),
                        ],
                      ),
                    ],
                  ),
                  h.tbody(
                    [],
                    model.rows.length
                      ? model.rows.flatMap((row) =>
                          routeRow(model, row, domains, destinations, h),
                        )
                      : [
                          h.tr(
                            [],
                            [
                              h.td(
                                [h.Colspan(4)],
                                ["No inbound address rules."],
                              ),
                            ],
                          ),
                        ],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
      ...(model.error ? [h.p([h.Role("alert")], [model.error])] : []),
      h.p([h.Role("status"), h.Class("settings-mail-status")], [model.status]),
    ],
  );
});
