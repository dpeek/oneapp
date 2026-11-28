import {
  button,
  checkbox,
  field,
  input,
  item,
  itemGroup,
  nativeSelect,
  spinner,
} from "@orumai/ui";
import { Effect, Schema } from "effect";
import { Command, Submodel, Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { mailPath } from "./inbox-contract.ts";
import {
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
    editing: Schema.Boolean,
  }),
]);
type Operation = typeof Operation.Type;
const Draft = Schema.Struct({
  address: Schema.String,
  mailboxId: Schema.String,
  enabled: Schema.Boolean,
});
const emptyRoute = { address: "", mailboxId: "", enabled: true };

export const Model = Schema.Struct({
  data: Schema.NullOr(MailSettings),
  mailboxes: Schema.NullOr(Mailboxes.fields.mailboxes),
  name: Schema.String,
  draft: Draft,
  editing: Schema.Boolean,
  request: Schema.NullOr(Schema.String),
  error: Schema.String,
  status: Schema.String,
});
type Model = typeof Model.Type;

export const initial: Model = {
  data: null,
  mailboxes: null,
  name: "",
  draft: emptyRoute,
  editing: false,
  request: null,
  error: "",
  status: "",
};

export const Message = defineMessageUnion({
  Requested: {},
  RequestedMailboxes: {},
  ChangedName: { name: Schema.String },
  CreatedMailbox: {},
  ChangedAddress: { address: Schema.String },
  ChangedDestination: { mailboxId: Schema.String },
  ChangedReceiving: { enabled: Schema.Boolean },
  EditedRoute: { route: InboundRoute },
  CancelledEdit: {},
  SubmittedRoute: {},
  Loaded: { request: Schema.String, data: MailSettings },
  LoadedMailboxes: { request: Schema.String, data: Mailboxes },
  SavedMailbox: { request: Schema.String, mailbox: Mailbox },
  SavedRoute: { request: Schema.String, route: InboundRoute },
  Failed: { request: Schema.String, error: Schema.String },
  SessionExpired: { request: Schema.String },
});
type Message = typeof Message.Type;

const Request = Command.define("RequestMailSettings", {
  args: { request: Schema.String, operation: Operation },
  messages: [
    Message.Loaded,
    Message.LoadedMailboxes,
    Message.SavedMailbox,
    Message.SavedRoute,
    Message.Failed,
    Message.SessionExpired,
  ],
  execute: ({ request, operation }) => {
    const failed = (error: string) => Message.Failed({ request, error });
    return Effect.tryPromise(async (signal) => {
      const resource = {
        Load: mailSettingsApiPath,
        LoadMailboxes: mailboxesApiPath,
        CreateMailbox: mailboxesApiPath,
        SaveRoute: inboundRoutesApiPath,
      }[operation._tag];
      const payload =
        operation._tag === "CreateMailbox"
          ? { name: operation.name }
          : operation._tag === "SaveRoute"
            ? operation.route
            : null;
      const response = await fetch(resource, {
        signal,
        cache: "no-store",
        ...(payload
          ? {
              method:
                operation._tag === "SaveRoute" && operation.editing
                  ? "PUT"
                  : "POST",
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
            : "Could not load Mail settings.",
        );
      }
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
  operation: Operation,
): Update.Return<Model, Message> => {
  const request = crypto.randomUUID();
  return {
    model: { ...model, request, error: "", status: "" },
    commands: [Request({ request, operation })],
  };
};

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> => {
  if ("request" in message && message.request !== model.request)
    return { model };
  return Message.match<Update.Return<Model, Message>>(message, {
    Requested: () =>
      model.request ? { model } : start(model, { _tag: "Load" }),
    RequestedMailboxes: () =>
      model.request ? { model } : start(model, { _tag: "LoadMailboxes" }),
    ChangedName: ({ name }) => ({ model: { ...model, name } }),
    CreatedMailbox: () => {
      if (model.request) return { model };
      const input = Schema.decodeUnknownOption(NewMailbox)({
        name: model.name,
      });
      return input._tag === "Some"
        ? start(model, { _tag: "CreateMailbox", ...input.value })
        : {
            model: {
              ...model,
              error: "Enter a mailbox name of 1 to 100 characters.",
            },
          };
    },
    ChangedAddress: ({ address }) => ({
      model: { ...model, draft: { ...model.draft, address } },
    }),
    ChangedDestination: ({ mailboxId }) => ({
      model: { ...model, draft: { ...model.draft, mailboxId } },
    }),
    ChangedReceiving: ({ enabled }) => ({
      model: { ...model, draft: { ...model.draft, enabled } },
    }),
    EditedRoute: ({ route }) => ({
      model: { ...model, draft: route, editing: true, error: "", status: "" },
    }),
    CancelledEdit: () => ({
      model: {
        ...model,
        draft: emptyRoute,
        editing: false,
        error: "",
        status: "",
      },
    }),
    SubmittedRoute: () => {
      if (model.request) return { model };
      const route = Schema.decodeUnknownOption(InboundRoute)(model.draft);
      return route._tag === "Some"
        ? start(model, {
            _tag: "SaveRoute",
            route: route.value,
            editing: model.editing,
          })
        : {
            model: {
              ...model,
              error:
                "Enter an exact inbound address and select a destination mailbox.",
            },
          };
    },
    Loaded: ({ data }) => ({
      model: { ...model, data, mailboxes: data.mailboxes, request: null },
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
    SavedRoute: ({ route }) => ({
      model: {
        ...model,
        data: model.data && {
          ...model.data,
          routes: [
            ...model.data.routes.filter(
              ({ address }) => address !== route.address,
            ),
            route,
          ].sort((a, b) => a.address.localeCompare(b.address)),
        },
        draft: emptyRoute,
        editing: false,
        request: null,
        status: `Saved rule for ${route.address}.`,
      },
    }),
    Failed: ({ error }) => ({ model: { ...model, request: null, error } }),
    SessionExpired: () => ({ model: initial }),
  });
};

const routeForm = (
  model: Model,
  options: readonly { value: string; label: string }[],
  h: HtmlBuilder<Message>,
) => {
  const pending = model.request !== null;
  const { address, mailboxId, enabled } = model.draft;
  return h.form(
    [h.Class("settings-mail-route-form"), h.OnSubmit(Message.SubmittedRoute())],
    [
      ...(!model.editing
        ? [
            field(
              "Exact recipient address",
              input(
                [
                  h.Type("email"),
                  h.Required(true),
                  h.Maxlength(254),
                  h.Value(address),
                  h.Disabled(pending),
                  h.OnInput((address) => Message.ChangedAddress({ address })),
                ],
                h,
              ),
              h,
            ),
          ]
        : []),
      nativeSelect(
        {
          label: "Destination mailbox",
          options: [{ value: "", label: "Choose a mailbox" }, ...options],
          value: mailboxId,
          disabled: pending,
          onChange: (mailboxId) => Message.ChangedDestination({ mailboxId }),
        },
        h,
      ),
      h.div(
        [h.Class("settings-mail-route-actions")],
        [
          checkbox(
            {
              id: "settings-mail-receiving",
              label: "Receiving enabled",
              checked: enabled,
              disabled: pending,
              onToggle: (enabled) => Message.ChangedReceiving({ enabled }),
            },
            h,
          ),
          h.div(
            [h.Class("settings-mail-route-actions")],
            [
              ...(model.editing
                ? [
                    button(
                      {
                        type: "button",
                        variant: "ghost",
                        disabled: pending,
                        onClick: Message.CancelledEdit(),
                        children: ["Cancel"],
                      },
                      h,
                    ),
                  ]
                : []),
              button(
                {
                  type: "submit",
                  disabled: pending || !mailboxId,
                  children: [model.editing ? "Save rule" : "Add address"],
                },
                h,
              ),
            ],
          ),
        ],
      ),
    ],
  );
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

  const names = new Map(
    data.destinations.map(({ id, name }) => [
      id,
      data.destinations.filter((mailbox) => mailbox.name === name).length > 1
        ? `${name} (${id.slice(0, 8)})`
        : name,
    ]),
  );
  const options = data.destinations.map(({ id }) => ({
    value: id,
    label: names.get(id)!,
  }));
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
        [
          h.Class("settings-section"),
          h.AriaLabelledBy("mail-settings-domains"),
        ],
        [
          h.h2([h.Id("mail-settings-domains")], ["Configured domains"]),
          h.ul(
            [h.Class("settings-mail-domains")],
            data.domains.map((domain) => h.li([h.Key(domain)], [domain])),
          ),
        ],
      ),
      h.section(
        [h.Class("settings-section"), h.AriaLabelledBy("mail-settings-rules")],
        [
          h.h2([h.Id("mail-settings-rules")], ["Inbound address rules"]),
          ...data.routes.map((route) =>
            h.div(
              [h.Key(route.address)],
              [
                item(
                  {
                    key: route.address,
                    title: route.address,
                    description: h.span(
                      [],
                      [
                        `${names.get(route.mailboxId) ?? route.mailboxId} · ${route.enabled ? "Receiving" : "Disabled"}`,
                      ],
                    ),
                    action: button(
                      {
                        size: "sm",
                        variant: "outline",
                        ariaLabel: `Edit ${route.address}`,
                        disabled: model.request !== null || model.editing,
                        onClick: Message.EditedRoute({ route }),
                        children: ["Edit"],
                      },
                      h,
                    ),
                  },
                  h,
                ),
                ...(model.editing && model.draft.address === route.address
                  ? [routeForm(model, options, h)]
                  : []),
              ],
            ),
          ),
          ...(!model.editing && options.length
            ? [routeForm(model, options, h)]
            : []),
        ],
      ),
      ...(model.error ? [h.p([h.Role("alert")], [model.error])] : []),
      h.p([h.Role("status"), h.Class("settings-mail-status")], [model.status]),
    ],
  );
});
