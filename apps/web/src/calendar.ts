import { Temporal } from "@js-temporal/polyfill";
import { button, buttonClassName, nativeSelect } from "@oneapp/ui";
import { Effect, Schema } from "effect";
import { Command, Mount, Submodel, type Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import {
  calendarApi,
  CalendarId,
  calendarNameLimit,
  CalendarSummary,
  defaultCalendarId,
  defaultCalendarName,
  CalendarDraft,
  CalendarImportReport,
  calendarImportLimit,
  calendarImportLimitLabel,
  CalendarOccurrence,
  calendarReminderMinutes,
  CalendarWeek,
} from "./calendar-contract.ts";
import {
  calendarDate,
  calendarDays,
  calendarWeekStart,
} from "./calendar-time.ts";

const ImportState = Schema.Struct({
  ics: Schema.String,
  report: CalendarImportReport,
});
const Editor = Schema.Struct({
  id: Schema.String,
  calendarId: CalendarId,
  revision: Schema.NullOr(Schema.String),
  draft: CalendarDraft,
});
const NameEditor = Schema.Struct({
  id: CalendarId,
  create: Schema.Boolean,
  name: Schema.String,
});
const RequestState = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([
    "load",
    "save",
    "delete",
    "preview",
    "import",
    "name",
  ]),
});

export const Model = Schema.Struct({
  start: Schema.String,
  zone: Schema.String,
  week: Schema.NullOr(CalendarWeek),
  calendars: Schema.Array(CalendarSummary),
  visible: Schema.NullOr(CalendarId),
  managing: Schema.Boolean,
  nameEditor: Schema.NullOr(NameEditor),
  request: Schema.NullOr(RequestState),
  selected: Schema.NullOr(CalendarOccurrence),
  editor: Schema.NullOr(Editor),
  confirmDelete: Schema.Boolean,
  importing: Schema.NullOr(CalendarId),
  preview: Schema.NullOr(ImportState),
  error: Schema.NullOr(Schema.String),
  notice: Schema.NullOr(Schema.String),
});
type Model = typeof Model.Type;

const today = () => Temporal.Now.plainDateISO();
export const initial = (): Model => ({
  start: calendarWeekStart(today()),
  zone: Temporal.Now.timeZoneId(),
  week: null,
  calendars: [],
  visible: null,
  managing: false,
  nameEditor: null,
  request: null,
  selected: null,
  editor: null,
  confirmDelete: false,
  importing: null,
  preview: null,
  error: null,
  notice: null,
});

export const Message = defineMessageUnion({
  Opened: {},
  ShiftedWeek: { days: Schema.Number },
  JumpedToToday: {},
  Retried: {},
  ShowedCalendar: { id: Schema.String },
  ManagedCalendars: {},
  NamedCalendar: { calendar: Schema.NullOr(CalendarSummary) },
  ChangedName: { name: Schema.String },
  SavedName: {},
  ClosedName: {},
  OpenedEvent: { event: CalendarOccurrence },
  NewEvent: { day: Schema.String },
  EditEvent: {},
  ChangedEventCalendar: { id: CalendarId },
  ChangedText: {
    field: Schema.Literals([
      "title",
      "location",
      "description",
      "start",
      "end",
    ]),
    value: Schema.String,
  },
  ToggledAllDay: {},
  ToggledReminder: {},
  SavedEvent: {},
  RequestedDelete: {},
  ConfirmedDelete: {},
  OpenedImport: {},
  ChangedImportCalendar: { id: CalendarId },
  ChangedImportFile: {},
  PreviewedFile: {},
  CommittedImport: {},
  ClosedPanel: {},
  Loaded: { request: Schema.String, week: CalendarWeek },
  Previewed: { request: Schema.String, preview: ImportState },
  Imported: { request: Schema.String, report: CalendarImportReport },
  Changed: {
    request: Schema.String,
    notice: Schema.String,
    calendarId: Schema.NullOr(CalendarId),
  },
  CalendarNamed: { request: Schema.String, calendar: CalendarSummary },
  Failed: { request: Schema.String, error: Schema.String },
  SessionExpired: { request: Schema.String },
  Focused: {},
});
type Message = typeof Message.Type;
export const OutMessage = defineMessageUnion({ SessionExpired: {} });
type OutMessage = typeof OutMessage.Type;

class CalendarRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const request = async (
  signal: AbortSignal,
  href: string,
  options?: RequestInit,
) => {
  const response = await fetch(href, { signal, cache: "no-store", ...options });
  if (response.ok) return response;
  const value = await response.json().catch(() => null);
  const error = Schema.decodeUnknownOption(
    Schema.Struct({ error: Schema.String }),
  )(value);
  throw new CalendarRequestError(
    response.status,
    error._tag === "Some"
      ? error.value.error
      : "Calendar is unavailable. Try again.",
  );
};

const jsonRequest = (method: string, body: object): RequestInit => ({
  method,
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", "x-effect-auth-csrf": "1" },
});
const run = <A extends Message>(
  id: string,
  work: (signal: AbortSignal) => Promise<A>,
) =>
  Effect.tryPromise({
    try: work,
    catch: (error) =>
      error instanceof CalendarRequestError
        ? error
        : new CalendarRequestError(
            0,
            "Could not complete the calendar request. Try again.",
          ),
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        error.status === 401
          ? Message.SessionExpired({ request: id })
          : Message.Failed({ request: id, error: error.message }),
      ),
    ),
  );

const LoadWeek = Command.define("LoadCalendarWeek", {
  args: { id: Schema.String, start: Schema.String, zone: Schema.String },
  messages: [Message.Loaded, Message.SessionExpired, Message.Failed],
  execute: ({ id, start, zone }) =>
    run(id, async (signal) => {
      const query = new URLSearchParams({ start, timeZone: zone });
      const response = await request(signal, `${calendarApi}?${query}`);
      return Message.Loaded({
        request: id,
        week: Schema.decodeUnknownSync(CalendarWeek)(await response.json()),
      });
    }),
});

const SaveEvent = Command.define("SaveCalendarEvent", {
  args: { id: Schema.String, editor: Editor },
  messages: [Message.Changed, Message.SessionExpired, Message.Failed],
  execute: ({ id, editor }) =>
    run(id, async (signal) => {
      const draft = editor.draft.allDay
        ? {
            ...editor.draft,
            reminder: false,
            end: calendarDays(editor.draft.end, 1),
          }
        : editor.draft;
      await request(
        signal,
        `${calendarApi}/events/${editor.id}`,
        jsonRequest("PUT", {
          revision: editor.revision,
          calendarId: editor.calendarId,
          draft,
        }),
      );
      return Message.Changed({
        request: id,
        notice: "Event saved.",
        calendarId: editor.calendarId,
      });
    }),
});

const DeleteEvent = Command.define("DeleteCalendarEvent", {
  args: { id: Schema.String, eventId: Schema.String, revision: Schema.String },
  messages: [Message.Changed, Message.SessionExpired, Message.Failed],
  execute: ({ id, eventId, revision }) =>
    run(id, async (signal) => {
      await request(signal, `${calendarApi}/events/${eventId}`, {
        method: "DELETE",
        headers: { "if-match": revision, "x-effect-auth-csrf": "1" },
      });
      return Message.Changed({
        request: id,
        notice: "Event deleted.",
        calendarId: null,
      });
    }),
});

const fileInput = "calendar-import-file";
const ImportFile = Command.define("ImportCalendarFile", {
  args: {
    id: Schema.String,
    calendarId: CalendarId,
    ics: Schema.NullOr(Schema.String),
  },
  messages: [
    Message.Previewed,
    Message.Imported,
    Message.SessionExpired,
    Message.Failed,
  ],
  execute: ({ id, calendarId, ics }) =>
    run(id, async (signal) => {
      const commit = ics !== null;
      let source = ics;
      if (source === null) {
        const input = document.getElementById(fileInput);
        const file =
          input instanceof HTMLInputElement ? input.files?.item(0) : null;
        if (!file || file.size > calendarImportLimit)
          throw new CalendarRequestError(
            400,
            `Choose an .ics file up to ${calendarImportLimitLabel}.`,
          );
        source = await file.text();
      }
      const response = await request(
        signal,
        `${calendarApi}/import${commit ? "" : "/preview"}`,
        jsonRequest("POST", { ics: source, calendarId }),
      );
      const report = Schema.decodeUnknownSync(CalendarImportReport)(
        await response.json(),
      );
      return commit
        ? Message.Imported({ request: id, report })
        : Message.Previewed({ request: id, preview: { ics: source, report } });
    }),
});

const SaveCalendarName = Command.define("SaveCalendarName", {
  args: { id: Schema.String, editor: NameEditor },
  messages: [Message.CalendarNamed, Message.SessionExpired, Message.Failed],
  execute: ({ id, editor }) =>
    run(id, async (signal) => {
      const response = await request(
        signal,
        `${calendarApi}/calendars/${editor.id}`,
        jsonRequest(editor.create ? "POST" : "PUT", { name: editor.name }),
      );
      const calendar = Schema.decodeUnknownSync(CalendarSummary)(
        await response.json(),
      );
      return Message.CalendarNamed({ request: id, calendar });
    }),
});

const FocusPanel = Mount.define("FocusCalendarPanel", {
  messages: [Message.Focused],
  execute: ({ element }) =>
    Effect.sync(() => {
      if (element instanceof HTMLElement) element.focus();
      return Message.Focused();
    }),
});

const closedPanel = {
  selected: null,
  editor: null,
  importing: null,
  preview: null,
  managing: false,
  nameEditor: null,
  confirmDelete: false,
} as const;

const load = (
  model: Model,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> => {
  const id = crypto.randomUUID();
  return {
    model: { ...model, error: null, request: { id, kind: "load" } },
    commands: [LoadWeek({ id, start: model.start, zone: model.zone })],
  };
};

const navigateWeek = (model: Model, start: string) =>
  load({ ...model, ...closedPanel, week: null, start, notice: null });

const busy = (model: Model) =>
  model.request !== null && model.request.kind !== "load";
const openPanel = (model: Model, panel: Partial<Model>) => ({
  model: { ...model, ...closedPanel, error: null, notice: null, ...panel },
});

const showDestination = (
  visible: Model["visible"],
  destination: string | null,
) => (visible && destination ? destination : visible);

const beginImport = (model: Model, ics: string | null) => {
  if (!model.importing) return { model };
  const id = crypto.randomUUID();
  return {
    model: {
      ...model,
      error: null,
      request: {
        id,
        kind: ics === null ? ("preview" as const) : ("import" as const),
      },
    },
    commands: [ImportFile({ id, calendarId: model.importing, ics })],
  };
};

export const update = (
  model: Model,
  message: Message,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> =>
  Message.match<Update.ReturnWithOutMessage<Model, Message, OutMessage>>(
    message,
    {
      Opened: () => (busy(model) ? { model } : load(model)),
      ShiftedWeek: ({ days }) =>
        busy(model)
          ? { model }
          : navigateWeek(model, calendarDays(model.start, days)),
      JumpedToToday: () =>
        busy(model)
          ? { model }
          : navigateWeek(model, calendarWeekStart(today())),
      Retried: () =>
        busy(model) ? { model } : load({ ...model, ...closedPanel }),
      ShowedCalendar: ({ id }) =>
        busy(model) ||
        (id !== "" && !model.calendars.some((calendar) => calendar.id === id))
          ? { model }
          : openPanel(model, { visible: id || null }),
      ManagedCalendars: () =>
        busy(model) ? { model } : openPanel(model, { managing: true }),
      NamedCalendar: ({ calendar }) =>
        busy(model)
          ? { model }
          : openPanel(model, {
              managing: true,
              nameEditor: {
                id: calendar?.id ?? crypto.randomUUID(),
                create: !calendar,
                name: calendar?.name ?? "",
              },
            }),
      ChangedName: ({ name }) =>
        !model.nameEditor || busy(model)
          ? { model }
          : {
              model: { ...model, nameEditor: { ...model.nameEditor, name } },
            },
      SavedName: () => {
        if (!model.nameEditor || busy(model)) return { model };
        const id = crypto.randomUUID();
        return {
          model: { ...model, error: null, request: { id, kind: "name" } },
          commands: [SaveCalendarName({ id, editor: model.nameEditor })],
        };
      },
      ClosedName: () =>
        busy(model) ? { model } : openPanel(model, { managing: true }),
      OpenedEvent: ({ event }) =>
        busy(model) ? { model } : openPanel(model, { selected: event }),
      NewEvent: ({ day }) =>
        busy(model)
          ? { model }
          : openPanel(model, {
              editor: {
                id: crypto.randomUUID(),
                calendarId: model.visible ?? defaultCalendarId,
                revision: null,
                draft: {
                  title: "",
                  location: "",
                  description: "",
                  allDay: false,
                  start: `${day}T09:00`,
                  end: `${day}T10:00`,
                  timeZone: model.zone,
                  reminder: false,
                },
              },
            }),
      EditEvent: () => {
        const event = model.selected;
        if (!event?.draft || busy(model)) return { model };
        const draft = event.allDay
          ? { ...event.draft, end: calendarDays(event.draft.end, -1) }
          : event.draft;
        return openPanel(model, {
          editor: {
            id: event.id,
            calendarId: event.calendarId,
            revision: event.revision,
            draft,
          },
        });
      },
      ChangedEventCalendar: ({ id }) =>
        !model.editor || busy(model)
          ? { model }
          : {
              model: { ...model, editor: { ...model.editor, calendarId: id } },
            },
      ChangedText: ({ field, value }) => {
        const editor = model.editor;
        if (!editor || busy(model)) return { model };
        return {
          model: {
            ...model,
            editor: { ...editor, draft: { ...editor.draft, [field]: value } },
          },
        };
      },
      ToggledAllDay: () => {
        const editor = model.editor;
        if (!editor || busy(model)) return { model };
        const draft = editor.draft;
        const allDay = !draft.allDay;
        const start = draft.start.slice(0, 10);
        const end = draft.end.slice(0, 10);
        return {
          model: {
            ...model,
            editor: {
              ...editor,
              draft: {
                ...draft,
                allDay,
                reminder: false,
                start: allDay ? start : `${start}T09:00`,
                end: allDay ? end : `${end}T10:00`,
                timeZone: draft.timeZone || model.zone,
              },
            },
          },
        };
      },
      ToggledReminder: () => {
        const editor = model.editor;
        if (!editor || busy(model)) return { model };
        return {
          model: {
            ...model,
            editor: {
              ...editor,
              draft: { ...editor.draft, reminder: !editor.draft.reminder },
            },
          },
        };
      },
      SavedEvent: () => {
        if (!model.editor || busy(model)) return { model };
        const id = crypto.randomUUID();
        return {
          model: { ...model, error: null, request: { id, kind: "save" } },
          commands: [SaveEvent({ id, editor: model.editor })],
        };
      },
      RequestedDelete: () =>
        busy(model) ? { model } : { model: { ...model, confirmDelete: true } },
      ConfirmedDelete: () => {
        if (!model.selected?.draft || busy(model)) return { model };
        const id = crypto.randomUUID();
        return {
          model: { ...model, error: null, request: { id, kind: "delete" } },
          commands: [
            DeleteEvent({
              id,
              eventId: model.selected.id,
              revision: model.selected.revision,
            }),
          ],
        };
      },
      OpenedImport: () =>
        busy(model)
          ? { model }
          : openPanel(model, {
              importing: model.visible ?? defaultCalendarId,
            }),
      ChangedImportCalendar: ({ id }) =>
        !model.importing || busy(model)
          ? { model }
          : {
              model: { ...model, importing: id, preview: null, error: null },
            },
      ChangedImportFile: () =>
        busy(model)
          ? { model }
          : {
              model: { ...model, preview: null, error: null },
            },
      PreviewedFile: () => (busy(model) ? { model } : beginImport(model, null)),
      CommittedImport: () =>
        !model.preview || busy(model)
          ? { model }
          : beginImport(model, model.preview.ics),
      ClosedPanel: () => (busy(model) ? { model } : openPanel(model, {})),
      Loaded: ({ request, week }) =>
        request !== model.request?.id
          ? { model }
          : {
              model: {
                ...model,
                week,
                calendars: week.calendars,
                request: null,
              },
            },
      Previewed: ({ request, preview }) =>
        request !== model.request?.id
          ? { model }
          : { model: { ...model, preview, request: null } },
      Imported: ({ request, report }) =>
        request !== model.request?.id
          ? { model }
          : load({
              ...model,
              ...closedPanel,
              visible: showDestination(model.visible, model.importing),
              notice: `Imported ${report.imported} events and series.`,
            }),
      Changed: ({ request, notice, calendarId }) =>
        request !== model.request?.id
          ? { model }
          : load({
              ...model,
              ...closedPanel,
              visible: showDestination(model.visible, calendarId),
              notice,
            }),
      CalendarNamed: ({ request, calendar }) => {
        if (request !== model.request?.id) return { model };
        const created = model.nameEditor?.create === true;
        return load({
          ...model,
          ...closedPanel,
          managing: true,
          visible: created ? calendar.id : model.visible,
          notice: created ? "Calendar created." : "Calendar renamed.",
        });
      },
      Failed: ({ request, error }) =>
        request !== model.request?.id
          ? { model }
          : { model: { ...model, request: null, error } },
      SessionExpired: ({ request }) =>
        request !== model.request?.id
          ? { model }
          : {
              model: { ...model, request: null },
              outMessage: OutMessage.SessionExpired(),
            },
      Focused: () => ({ model }),
    },
  );

const plain = (date: string, options: Intl.DateTimeFormatOptions) =>
  calendarDate(date).toLocaleString(undefined, options);
const clock = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat(undefined, { timeStyle: "short", timeZone }).format(
    Temporal.Instant.from(iso).epochMilliseconds,
  );
const localDate = (iso: string, timeZone: string) =>
  Temporal.Instant.from(iso)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();

const eventsForDay = (
  events: readonly CalendarOccurrence[],
  day: string,
  zone: string,
) => {
  const midnight = calendarDate(day).toZonedDateTime(zone).toInstant();
  const next = calendarDate(calendarDays(day, 1))
    .toZonedDateTime(zone)
    .toInstant();
  return events.filter((event) =>
    event.allDay
      ? event.start <= day && event.end > day
      : Temporal.Instant.compare(event.start, next) < 0 &&
        (Temporal.Instant.compare(event.end, midnight) > 0 ||
          (event.start === event.end &&
            Temporal.Instant.compare(event.start, midnight) >= 0)),
  );
};

type H = HtmlBuilder<Message>;

const blankCalendar = { id: defaultCalendarId, name: defaultCalendarName };
const calendarChoices = (model: Model) =>
  model.calendars.length ? model.calendars : [blankCalendar];
const calendarName = (model: Model, id: string) =>
  calendarChoices(model).find((calendar) => calendar.id === id)?.name ??
  "Calendar";

const calendarOptions = (model: Model) =>
  calendarChoices(model).map((calendar) => ({
    value: calendar.id,
    label: calendar.name,
  }));

const exportLink = (calendar: typeof CalendarSummary.Type, h: H) =>
  h.a(
    [
      h.Href(
        `${calendarApi}/export?${new URLSearchParams({ calendarId: calendar.id })}`,
      ),
      h.Class(buttonClassName({ variant: "outline" })),
      h.Download(""),
      h.AriaLabel(`Export ${calendar.name}`),
    ],
    ["Export"],
  );

const calendarsView = (model: Model, h: H) => {
  const disabled = busy(model);
  const editor = model.nameEditor;
  return h.section(
    [h.Class("calendar-panel"), h.AriaLabel("Manage calendars")],
    [
      h.h2([h.Tabindex(-1), h.OnMount(FocusPanel())], ["Calendars"]),
      h.ul(
        [h.Class("calendar-list")],
        calendarChoices(model).map((calendar) =>
          h.li(
            [h.Key(calendar.id)],
            [
              h.span([], [calendar.name]),
              h.div(
                [h.Class("calendar-actions")],
                [
                  button(
                    {
                      variant: "ghost",
                      disabled: disabled || Boolean(editor),
                      ariaLabel: `Rename ${calendar.name}`,
                      onClick: Message.NamedCalendar({ calendar }),
                      children: ["Rename"],
                    },
                    h,
                  ),
                  exportLink(calendar, h),
                ],
              ),
            ],
          ),
        ),
      ),
      editor
        ? h.form(
            [h.OnSubmit(Message.SavedName())],
            [
              h.label(
                [h.Class("calendar-field")],
                [
                  h.span([], ["Calendar name"]),
                  h.input([
                    h.Type("text"),
                    h.Value(editor.name),
                    h.Required(true),
                    h.Maxlength(calendarNameLimit),
                    h.Disabled(disabled),
                    h.OnMount(FocusPanel()),
                    h.OnInput((name) => Message.ChangedName({ name })),
                  ]),
                ],
              ),
              h.div(
                [h.Class("calendar-actions")],
                [
                  button(
                    {
                      type: "submit",
                      disabled,
                      children: [
                        editor.create ? "Create calendar" : "Save name",
                      ],
                    },
                    h,
                  ),
                  button(
                    {
                      variant: "ghost",
                      disabled,
                      onClick: Message.ClosedName(),
                      children: ["Cancel"],
                    },
                    h,
                  ),
                ],
              ),
            ],
          )
        : h.div(
            [h.Class("calendar-actions")],
            [
              button(
                {
                  disabled,
                  onClick: Message.NamedCalendar({ calendar: null }),
                  children: ["New calendar"],
                },
                h,
              ),
              button(
                {
                  variant: "ghost",
                  disabled,
                  onClick: Message.ClosedPanel(),
                  children: ["Done"],
                },
                h,
              ),
            ],
          ),
    ],
  );
};

const editorView = (model: Model, h: H) => {
  const editor = model.editor!;
  const { draft } = editor;
  const disabled = busy(model);
  const textInput = (
    label: string,
    field: "title" | "location" | "start" | "end",
    type: string,
    required = true,
  ) =>
    h.label(
      [h.Class("calendar-field")],
      [
        h.span([], [label]),
        h.input([
          h.Type(type),
          h.Value(draft[field]),
          h.Required(required),
          h.Disabled(disabled),
          h.OnInput((value) => Message.ChangedText({ field, value })),
          ...(type === "datetime-local" ? [h.Attribute("step", "1")] : []),
          ...(field === "title" || field === "location"
            ? [h.Maxlength(field === "title" ? 250 : 500)]
            : []),
        ]),
      ],
    );
  return h.section(
    [h.Class("calendar-panel"), h.AriaLabel("Event editor")],
    [
      h.h2(
        [h.Tabindex(-1), h.OnMount(FocusPanel())],
        [editor.revision ? "Edit event" : "New event"],
      ),
      h.form(
        [h.OnSubmit(Message.SavedEvent())],
        [
          textInput("Title", "title", "text"),
          nativeSelect(
            {
              label: "Calendar",
              value: editor.calendarId,
              options: calendarOptions(model),
              disabled,
              onChange: (id) => Message.ChangedEventCalendar({ id }),
            },
            h,
          ),
          h.label(
            [h.Class("calendar-checkbox")],
            [
              h.input([
                h.Type("checkbox"),
                h.Checked(draft.allDay),
                h.Disabled(disabled),
                h.OnChange(() => Message.ToggledAllDay()),
              ]),
              "All day",
            ],
          ),
          h.div(
            [h.Class("calendar-form-dates")],
            [
              textInput(
                draft.allDay ? "First day" : "Starts",
                "start",
                draft.allDay ? "date" : "datetime-local",
              ),
              textInput(
                draft.allDay ? "Last day" : "Ends",
                "end",
                draft.allDay ? "date" : "datetime-local",
              ),
            ],
          ),
          ...(draft.allDay
            ? []
            : [h.p([h.Class("calendar-muted")], [draft.timeZone])]),
          textInput("Location", "location", "text", false),
          h.label(
            [h.Class("calendar-field")],
            [
              h.span([], ["Notes"]),
              h.textarea([
                h.Value(draft.description),
                h.Maxlength(8000),
                h.Disabled(disabled),
                h.OnInput((value) =>
                  Message.ChangedText({ field: "description", value }),
                ),
              ]),
            ],
          ),
          ...(draft.allDay
            ? []
            : [
                h.label(
                  [h.Class("calendar-checkbox")],
                  [
                    h.input([
                      h.Type("checkbox"),
                      h.Checked(draft.reminder),
                      h.Disabled(disabled),
                      h.OnChange(() => Message.ToggledReminder()),
                    ]),
                    `Remind me ${calendarReminderMinutes} minutes before`,
                  ],
                ),
                ...(!model.week?.remindersAvailable
                  ? [
                      h.p(
                        [h.Class("calendar-muted")],
                        [
                          "Set up notifications on a device in ",
                          h.a([h.Href("/settings")], ["Settings"]),
                          ".",
                        ],
                      ),
                    ]
                  : []),
              ]),
          h.div(
            [h.Class("calendar-actions")],
            [
              button(
                {
                  type: "submit",
                  disabled,
                  children: [
                    model.request?.kind === "save" ? "Saving…" : "Save event",
                  ],
                },
                h,
              ),
              button(
                {
                  variant: "ghost",
                  disabled,
                  onClick: Message.ClosedPanel(),
                  children: ["Cancel"],
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

const detailsView = (model: Model, h: H) => {
  const event = model.selected!;
  const date = (value: string) =>
    plain(value, { weekday: "short", month: "short", day: "numeric" });
  const time = (value: string) =>
    `${date(localDate(value, model.zone))}, ${clock(value, model.zone)}`;
  const last = event.allDay ? calendarDays(event.end, -1) : event.end;
  const when = event.allDay
    ? (event.start === last
        ? date(event.start)
        : `${date(event.start)} – ${date(last)}`) + " · All day"
    : event.start === event.end
      ? time(event.start)
      : `${time(event.start)} – ${time(event.end)}`;
  const disabled = busy(model);
  return h.section(
    [h.Class("calendar-panel"), h.AriaLabel("Event details")],
    [
      h.h2([h.Tabindex(-1), h.OnMount(FocusPanel())], [event.title]),
      h.p([h.Class("calendar-muted")], [when]),
      h.p([h.Class("calendar-muted")], [calendarName(model, event.calendarId)]),
      ...(event.recurring
        ? [h.p([h.Class("calendar-muted")], ["Recurring event"])]
        : []),
      ...(event.location ? [h.p([], [event.location])] : []),
      ...(event.description
        ? [h.p([h.Class("calendar-notes")], [event.description])]
        : []),
      ...(event.draft?.reminder
        ? [h.p([], [`Reminder ${calendarReminderMinutes} minutes before`])]
        : []),
      ...(model.confirmDelete ? [h.p([], ["Delete this event?"])] : []),
      h.div(
        [h.Class("calendar-actions")],
        [
          ...(event.draft && !model.confirmDelete
            ? [
                button(
                  {
                    variant: "outline",
                    disabled,
                    onClick: Message.EditEvent(),
                    children: ["Edit"],
                  },
                  h,
                ),
                button(
                  {
                    variant: "ghost",
                    disabled,
                    onClick: Message.RequestedDelete(),
                    children: ["Delete"],
                  },
                  h,
                ),
              ]
            : []),
          ...(model.confirmDelete
            ? [
                button(
                  {
                    disabled,
                    onClick: Message.ConfirmedDelete(),
                    children: ["Delete event"],
                  },
                  h,
                ),
              ]
            : []),
          button(
            {
              variant: "ghost",
              disabled,
              onClick: Message.ClosedPanel(),
              children: [model.confirmDelete ? "Cancel" : "Close"],
            },
            h,
          ),
        ],
      ),
    ],
  );
};

const importView = (model: Model, h: H) => {
  const report = model.preview?.report;
  const disabled = busy(model);
  return h.section(
    [h.Class("calendar-panel"), h.AriaLabel("Import calendar")],
    [
      h.h2([h.Tabindex(-1), h.OnMount(FocusPanel())], ["Import calendar"]),
      report
        ? h.div(
            [],
            [
              h.p(
                [],
                [
                  `${report.available} ready to import · ${report.existing} already imported · ${report.total - report.available - report.existing} skipped`,
                ],
              ),
              h.p([], [`Import into ${calendarName(model, model.importing!)}`]),
              ...(report.warnings.length
                ? [
                    h.ul(
                      [h.Class("calendar-import-warnings")],
                      report.warnings.map((warning) => h.li([], [warning])),
                    ),
                  ]
                : []),
              h.div(
                [h.Class("calendar-actions")],
                [
                  button(
                    {
                      disabled: disabled || !report.available,
                      onClick: Message.CommittedImport(),
                      children: [disabled ? "Importing…" : "Import events"],
                    },
                    h,
                  ),
                  button(
                    {
                      variant: "ghost",
                      disabled,
                      onClick: Message.ChangedImportFile(),
                      children: ["Change file or calendar"],
                    },
                    h,
                  ),
                  button(
                    {
                      variant: "ghost",
                      disabled,
                      onClick: Message.ClosedPanel(),
                      children: ["Done"],
                    },
                    h,
                  ),
                ],
              ),
            ],
          )
        : h.form(
            [h.OnSubmit(Message.PreviewedFile())],
            [
              nativeSelect(
                {
                  label: "Import into",
                  value: model.importing!,
                  options: calendarOptions(model),
                  disabled,
                  onChange: (id) => Message.ChangedImportCalendar({ id }),
                },
                h,
              ),
              h.label(
                [h.Class("calendar-field")],
                [
                  h.span(
                    [],
                    [`Calendar file (.ics, up to ${calendarImportLimitLabel})`],
                  ),
                  h.input([
                    h.Type("file"),
                    h.Id(fileInput),
                    h.Required(true),
                    h.Accept(".ics,text/calendar"),
                    h.Disabled(disabled),
                  ]),
                ],
              ),
              h.div(
                [h.Class("calendar-actions")],
                [
                  button(
                    {
                      type: "submit",
                      disabled,
                      children: [disabled ? "Reading…" : "Preview import"],
                    },
                    h,
                  ),
                  button(
                    {
                      variant: "ghost",
                      disabled,
                      onClick: Message.ClosedPanel(),
                      children: ["Cancel"],
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
  const current = today().toString();
  const days = Array.from({ length: 7 }, (_, offset) =>
    calendarDays(model.start, offset),
  );
  const period = (day: string) =>
    plain(day, { month: "short", day: "numeric" });
  const eventDate = days.includes(current) ? current : model.start;
  const disabled = busy(model);
  const calendars = calendarChoices(model);
  const selectedCalendar = calendars.find(
    (calendar) => calendar.id === model.visible,
  );
  const exportCalendar =
    selectedCalendar ?? (calendars.length === 1 ? calendars[0] : undefined);
  const events =
    model.week?.events.filter(
      (event) => !model.visible || event.calendarId === model.visible,
    ) ?? [];
  const showCalendarNames = calendars.length > 1 && !model.visible;
  return h.div(
    [h.Class("calendar")],
    [
      h.header(
        [h.Class("calendar-header")],
        [
          h.h1([], ["Calendar"]),
          h.div(
            [h.Class("calendar-actions")],
            [
              button(
                {
                  variant: "outline",
                  disabled,
                  onClick: Message.OpenedImport(),
                  children: ["Import"],
                },
                h,
              ),
              exportCalendar
                ? exportLink(exportCalendar, h)
                : button(
                    {
                      variant: "outline",
                      disabled,
                      onClick: Message.ManagedCalendars(),
                      children: ["Export"],
                    },
                    h,
                  ),
              button(
                {
                  variant: "outline",
                  disabled,
                  onClick: Message.ManagedCalendars(),
                  children: ["Calendars"],
                },
                h,
              ),
              button(
                {
                  disabled,
                  onClick: Message.NewEvent({ day: eventDate }),
                  children: ["New event"],
                },
                h,
              ),
            ],
          ),
        ],
      ),
      ...(model.error
        ? [
            h.div(
              [h.Class("calendar-error")],
              [
                h.p([h.Role("alert")], [model.error]),
                button(
                  {
                    variant: "outline",
                    onClick: Message.Retried(),
                    children: ["Refresh calendar"],
                  },
                  h,
                ),
              ],
            ),
          ]
        : []),
      ...(model.notice ? [h.p([h.Role("status")], [model.notice])] : []),
      ...(model.editor
        ? [editorView(model, h)]
        : model.importing
          ? [importView(model, h)]
          : model.managing
            ? [calendarsView(model, h)]
            : model.selected
              ? [detailsView(model, h)]
              : []),
      h.div(
        [h.Class("calendar-toolbar")],
        [
          h.h2(
            [],
            [
              `${period(model.start)} – ${period(days[6]!)} · ${calendarDate(days[6]!).year}`,
            ],
          ),
          h.div(
            [h.Class("calendar-actions")],
            [
              ...(calendars.length > 1
                ? [
                    nativeSelect(
                      {
                        label: "Show calendar",
                        value: model.visible ?? "",
                        options: [
                          { value: "", label: "All calendars" },
                          ...calendarOptions(model),
                        ],
                        disabled,
                        onChange: (id) => Message.ShowedCalendar({ id }),
                      },
                      h,
                    ),
                  ]
                : []),
              button(
                {
                  variant: "outline",
                  disabled,
                  ariaLabel: "Previous week",
                  onClick: Message.ShiftedWeek({ days: -7 }),
                  children: ["‹"],
                },
                h,
              ),
              button(
                {
                  variant: "outline",
                  disabled,
                  onClick: Message.JumpedToToday(),
                  children: ["Today"],
                },
                h,
              ),
              button(
                {
                  variant: "outline",
                  disabled,
                  ariaLabel: "Next week",
                  onClick: Message.ShiftedWeek({ days: 7 }),
                  children: ["›"],
                },
                h,
              ),
            ],
          ),
        ],
      ),
      ...(!model.week && model.request?.kind === "load"
        ? [h.p([h.Role("status")], ["Loading calendar…"])]
        : []),
      ...(model.week?.incomplete
        ? [
            h.p(
              [h.Role("status")],
              ["Some events could not be displayed in this week."],
            ),
          ]
        : []),
      ...(model.week
        ? [
            ...(events.length === 0
              ? [h.p([h.Class("calendar-empty")], ["No events this week."])]
              : []),
            h.div(
              [h.Class("calendar-week"), h.AriaLabel("Week schedule")],
              days.map((day) => {
                const dayEvents = eventsForDay(events, day, model.zone);
                return h.section(
                  [
                    h.Class("calendar-day"),
                    h.DataAttribute(
                      "empty",
                      dayEvents.length ? "false" : "true",
                    ),
                    h.DataAttribute(
                      "today",
                      day === current ? "true" : "false",
                    ),
                  ],
                  [
                    h.h3(
                      [],
                      [
                        h.span([], [plain(day, { weekday: "short" })]),
                        h.span([], [calendarDate(day).day.toString()]),
                        h.span(
                          [h.Class("calendar-day-mobile")],
                          [
                            plain(day, {
                              weekday: "long",
                              month: "long",
                              day: "numeric",
                            }),
                          ],
                        ),
                      ],
                    ),
                    ...(dayEvents.length
                      ? [
                          h.ul(
                            [],
                            dayEvents.map((event) =>
                              h.li(
                                [],
                                [
                                  h.button(
                                    [
                                      h.Type("button"),
                                      h.Class("calendar-event"),
                                      h.Disabled(disabled),
                                      h.OnClick(Message.OpenedEvent({ event })),
                                      h.DataAttribute(
                                        "all-day",
                                        event.allDay ? "true" : "false",
                                      ),
                                    ],
                                    [
                                      h.span(
                                        [h.Class("calendar-event-time")],
                                        [
                                          event.allDay
                                            ? "All day"
                                            : localDate(
                                                  event.start,
                                                  model.zone,
                                                ) === day
                                              ? clock(event.start, model.zone)
                                              : "Continues",
                                        ],
                                      ),
                                      h.span(
                                        [h.Class("calendar-event-summary")],
                                        [
                                          h.span([], [event.title]),
                                          ...(showCalendarNames
                                            ? [
                                                h.span(
                                                  [
                                                    h.Class(
                                                      "calendar-event-time",
                                                    ),
                                                  ],
                                                  [
                                                    calendarName(
                                                      model,
                                                      event.calendarId,
                                                    ),
                                                  ],
                                                ),
                                              ]
                                            : []),
                                        ],
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ]
                      : []),
                  ],
                );
              }),
            ),
          ]
        : []),
    ],
  );
});
