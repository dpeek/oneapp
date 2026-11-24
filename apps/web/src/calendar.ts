import { Temporal } from "@js-temporal/polyfill";
import {
  button,
  ColorPicker,
  dialog,
  DropdownMenu,
  ellipsisIcon,
  nativeSelect,
  outlineIcon,
  plusIcon,
  Sheet,
  sidebarClassNames,
  sidebarItemClassName,
} from "@oneapp/ui";
import { Effect, Option, Schema } from "effect";
import { Command, Mount, Submodel, Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import {
  calendarApi,
  CalendarColor,
  defaultCalendarColor,
  CalendarId,
  calendarListPath,
  calendarNameLimit,
  CalendarSummary,
  defaultCalendarId,
  defaultCalendarName,
  CalendarDraft,
  CalendarImportReport,
  CalendarFrequency,
  CalendarRepeat,
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
import { workspace } from "./workspace.ts";

const MenuTarget = Schema.Struct({
  calendarId: CalendarId,
  surface: Schema.Literals(["sidebar", "sheet"]),
});
type MenuTarget = typeof MenuTarget.Type;
const menuId = ({ calendarId, surface }: MenuTarget) =>
  `calendar-actions-${surface}-${calendarId}`;
type CalendarAction = "edit" | "import" | "export";
const menu = DropdownMenu.create<CalendarAction>();

const ImportState = Schema.Struct({
  ics: Schema.String,
  report: CalendarImportReport,
});
const Editor = Schema.Struct({
  id: Schema.String,
  calendarId: CalendarId,
  revision: Schema.NullOr(Schema.String),
  draft: CalendarDraft,
  repeat: Schema.NullOr(CalendarRepeat),
  scope: Schema.Literals(["event", "occurrence", "series"]),
  occurrence: Schema.NullOr(Schema.String),
});
const CalendarEditor = Schema.Struct({
  id: CalendarId,
  create: Schema.Boolean,
  name: Schema.String,
  picker: ColorPicker.Model,
});
const RequestState = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([
    "load",
    "save",
    "delete",
    "preview",
    "import",
    "calendar",
  ]),
});

export const Model = Schema.Struct({
  start: Schema.String,
  zone: Schema.String,
  week: Schema.NullOr(CalendarWeek),
  calendars: Schema.Array(CalendarSummary),
  visible: Schema.NullOr(CalendarId),
  folderSheet: Sheet.Model,
  menus: Schema.Record(Schema.String, DropdownMenu.Model),
  calendarEditor: Schema.NullOr(CalendarEditor),
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
  folderSheet: Sheet.init({ id: "calendar-folders" }),
  menus: {},
  calendarEditor: null,
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
  Opened: { id: Schema.NullOr(CalendarId), refresh: Schema.Boolean },
  ShiftedWeek: { days: Schema.Number },
  JumpedToToday: {},
  Retried: {},
  GotFolderSheetMessage: { message: Sheet.Message },
  GotMenuMessage: { target: MenuTarget, message: DropdownMenu.Message },
  NewCalendar: {},
  DownloadStarted: {},
  ChangedName: { name: Schema.String },
  GotColorPicker: { message: ColorPicker.Message },
  SavedCalendar: {},
  OpenedEvent: { event: CalendarOccurrence },
  NewEvent: { day: Schema.String },
  EditEvent: { series: Schema.Boolean },
  ChangedFrequency: { frequency: Schema.NullOr(CalendarFrequency) },
  ChangedRepeatEnd: { until: Schema.String },
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
  ClosedEventEditor: {},
  RequestedDelete: {},
  ConfirmedDelete: {},
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
  CalendarSaved: { request: Schema.String, calendar: CalendarSummary },
  Failed: { request: Schema.String, error: Schema.String },
  SessionExpired: { request: Schema.String },
  Focused: {},
});
type Message = typeof Message.Type;
export const OutMessage = defineMessageUnion({
  SessionExpired: {},
  OpenCalendar: { id: CalendarId },
});
export type OutMessage = typeof OutMessage.Type;

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
      const draft = {
        ...editor.draft,
        end: editor.draft.allDay
          ? calendarDays(editor.draft.end, 1)
          : editor.draft.end,
        reminder:
          !editor.draft.allDay &&
          !editor.repeat &&
          editor.scope !== "occurrence" &&
          editor.draft.reminder,
      };
      await request(
        signal,
        `${calendarApi}/events/${editor.id}`,
        jsonRequest("PUT", {
          revision: editor.revision,
          calendarId: editor.calendarId,
          draft,
          repeat: editor.repeat,
          ...(editor.occurrence !== null
            ? { occurrence: editor.occurrence }
            : {}),
        }),
      );
      return Message.Changed({
        request: id,
        notice: editor.scope === "series" ? "Series saved." : "Event saved.",
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

const SaveCalendar = Command.define("SaveCalendar", {
  args: {
    request: Schema.String,
    calendarId: CalendarId,
    create: Schema.Boolean,
    name: Schema.String,
    color: CalendarColor,
  },
  messages: [Message.CalendarSaved, Message.SessionExpired, Message.Failed],
  execute: ({ request: id, calendarId, create, name, color }) =>
    run(id, async (signal) => {
      const response = await request(
        signal,
        `${calendarApi}/calendars/${calendarId}`,
        jsonRequest(create ? "POST" : "PUT", { name, color }),
      );
      const calendar = Schema.decodeUnknownSync(CalendarSummary)(
        await response.json(),
      );
      return Message.CalendarSaved({ request: id, calendar });
    }),
});

const DownloadCalendar = Command.define("DownloadCalendar", {
  args: { id: CalendarId },
  messages: [Message.DownloadStarted],
  execute: ({ id }) =>
    Effect.sync(() => {
      const link = document.createElement("a");
      link.href = `${calendarApi}/export?${new URLSearchParams({ calendarId: id })}`;
      link.download = "";
      document.body.append(link);
      link.click();
      link.remove();
      return Message.DownloadStarted();
    }),
});

const OpenCalendarDialog = Mount.define("OpenCalendarDialog", {
  messages: [Message.Focused],
  execute: ({ element }) =>
    Effect.sync(() => {
      if (element instanceof HTMLDialogElement && !element.open)
        element.showModal();
      return Message.Focused();
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
  calendarEditor: null,
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

const afterMutation = (
  model: Model,
  notice: string,
  destination: string | null,
) => {
  const result = load({ ...model, ...closedPanel, notice });
  return destination && destination !== model.visible
    ? { ...result, outMessage: OutMessage.OpenCalendar({ id: destination }) }
    : result;
};

const toFolderSheet = (message: typeof Sheet.Message.Type) =>
  Message.GotFolderSheetMessage({ message });
export const closeFolderSheet = () =>
  toFolderSheet(Sheet.Message.RequestedClose());

const foldFolderSheet = Update.foldChild({
  update: Sheet.update,
  read: (model: Model) => Option.some(model.folderSheet),
  write: (model, folderSheet) => ({ ...model, folderSheet }),
  toParentMessage: toFolderSheet,
  foldOutMessage: () => (model) => ({ model }),
});

const menuModel = (model: Model, target: MenuTarget) =>
  model.menus[menuId(target)] ?? DropdownMenu.init({ id: menuId(target) });

const calendarEditorFor = (calendar?: typeof CalendarSummary.Type) => ({
  id: calendar?.id ?? crypto.randomUUID(),
  create: !calendar,
  name: calendar?.name ?? "",
  picker: ColorPicker.init(
    "calendar-color-picker",
    calendar?.color ?? defaultCalendarColor,
  ),
});

const toColorPicker = (message: typeof ColorPicker.Message.Type) =>
  Message.GotColorPicker({ message });

const foldColorPicker = Update.foldChild({
  update: ColorPicker.update,
  read: (model: Model) => Option.fromNullishOr(model.calendarEditor?.picker),
  write: (model, picker) =>
    model.calendarEditor
      ? { ...model, calendarEditor: { ...model.calendarEditor, picker } }
      : model,
  toParentMessage: toColorPicker,
});

const closeSheetAndOpenPanel = (model: Model, panel: Partial<Model>) =>
  foldFolderSheet(
    openPanel(model, panel).model,
    Sheet.Message.RequestedClose(),
  );

const foldMenu = Update.foldChildAt({
  update: menu.update,
  readAt: (model: Model, target: MenuTarget) =>
    Option.some(menuModel(model, target)),
  writeAt: (model, target, child) => ({
    ...model,
    menus: { ...model.menus, [menuId(target)]: child },
  }),
  toParentMessage: (target, message) =>
    Message.GotMenuMessage({ target, message }),
  foldOutMessage:
    (target: MenuTarget) =>
    ({ value }: { value: CalendarAction }): Update.Step<Model, Message> =>
    (model) => {
      const calendar = calendarChoices(model).find(
        ({ id }) => id === target.calendarId,
      );
      if (busy(model) || !calendar) return { model };
      if (value === "export")
        return { model, commands: [DownloadCalendar({ id: calendar.id })] };
      return closeSheetAndOpenPanel(
        model,
        value === "edit"
          ? { calendarEditor: calendarEditorFor(calendar) }
          : { importing: calendar.id },
      );
    },
});

const updateFolderSheet = (
  model: Model,
  message: typeof Sheet.Message.Type,
) => {
  if (message._tag !== "RequestedClose") return foldFolderSheet(model, message);
  const menuSteps = calendarChoices(model).flatMap(({ id: calendarId }) => {
    const target = { calendarId, surface: "sheet" } as const;
    return model.menus[menuId(target)]?.isOpen
      ? [foldMenu(target, DropdownMenu.Message.Closed())]
      : [];
  });
  return Update.combine(model, [...menuSteps, foldFolderSheet(message)]);
};

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
      Opened: ({ id, refresh }) => {
        if (busy(model)) return { model: { ...model, visible: id } };
        const next = { ...model, ...closedPanel, visible: id };
        return refresh || (!next.week && !next.request)
          ? load(next)
          : { model: next };
      },
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
      GotFolderSheetMessage: ({ message }) => updateFolderSheet(model, message),
      GotMenuMessage: ({ target, message }) => foldMenu(model, target, message),
      NewCalendar: () =>
        busy(model)
          ? { model }
          : closeSheetAndOpenPanel(model, {
              calendarEditor: calendarEditorFor(),
            }),
      DownloadStarted: () => ({ model }),
      ChangedName: ({ name }) =>
        !model.calendarEditor || busy(model)
          ? { model }
          : {
              model: {
                ...model,
                calendarEditor: { ...model.calendarEditor, name },
              },
            },
      GotColorPicker: ({ message }) =>
        busy(model) ? { model } : foldColorPicker(model, message),
      SavedCalendar: () => {
        const editor = model.calendarEditor;
        if (!editor || busy(model)) return { model };
        const id = crypto.randomUUID();
        return {
          model: { ...model, error: null, request: { id, kind: "calendar" } },
          commands: [
            SaveCalendar({
              request: id,
              calendarId: editor.id,
              create: editor.create,
              name: editor.name,
              color: ColorPicker.hex(editor.picker),
            }),
          ],
        };
      },
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
                repeat: null,
                scope: "event",
                occurrence: null,
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
      EditEvent: ({ series }) => {
        const event = model.selected;
        const draft = series ? event?.series?.draft : event?.draft;
        if (!event || !draft || busy(model)) return { model };
        return openPanel(model, {
          selected: event,
          editor: {
            id: event.id,
            calendarId: event.calendarId,
            revision: event.revision,
            draft: draft.allDay
              ? { ...draft, end: calendarDays(draft.end, -1) }
              : draft,
            repeat: series ? (event.series?.repeat ?? null) : null,
            scope: series ? "series" : event.recurring ? "occurrence" : "event",
            occurrence: !series && event.recurring ? event.occurrence : null,
          },
        });
      },
      ChangedEventCalendar: ({ id }) =>
        !model.editor || busy(model) || model.editor.scope === "occurrence"
          ? { model }
          : {
              model: { ...model, editor: { ...model.editor, calendarId: id } },
            },
      ChangedFrequency: ({ frequency }) => {
        const editor = model.editor;
        if (!editor || busy(model) || editor.scope === "occurrence")
          return { model };
        const repeat = frequency
          ? { frequency, until: editor.repeat?.until ?? null }
          : null;
        return { model: { ...model, editor: { ...editor, repeat } } };
      },
      ChangedRepeatEnd: ({ until }) => {
        const editor = model.editor;
        if (!editor?.repeat || busy(model)) return { model };
        return {
          model: {
            ...model,
            editor: {
              ...editor,
              repeat: { ...editor.repeat, until: until || null },
            },
          },
        };
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
      ClosedEventEditor: () =>
        busy(model)
          ? { model }
          : { model: { ...model, editor: null, error: null } },
      RequestedDelete: () =>
        busy(model) ? { model } : { model: { ...model, confirmDelete: true } },
      ConfirmedDelete: () => {
        if (!model.selected?.draft || model.selected.recurring || busy(model))
          return { model };
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
          : afterMutation(
              model,
              `Imported ${report.imported} events and series.`,
              model.visible ? model.importing : null,
            ),
      Changed: ({ request, notice, calendarId }) =>
        request !== model.request?.id
          ? { model }
          : afterMutation(model, notice, model.visible ? calendarId : null),
      CalendarSaved: ({ request, calendar }) => {
        if (request !== model.request?.id) return { model };
        const created = model.calendarEditor?.create === true;
        const calendars = created
          ? [...model.calendars, calendar]
          : model.calendars.map((entry) =>
              entry.id === calendar.id ? calendar : entry,
            );
        return afterMutation(
          { ...model, calendars },
          created ? "Calendar created." : "Calendar updated.",
          created ? calendar.id : null,
        );
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

const blankCalendar = {
  id: defaultCalendarId,
  name: defaultCalendarName,
  color: defaultCalendarColor,
};
const calendarChoices = (model: Model) =>
  model.calendars.length ? model.calendars : [blankCalendar];
const calendarFor = (model: Model, id: string) =>
  calendarChoices(model).find((calendar) => calendar.id === id);

const calendarName = (model: Model, id: string) =>
  calendarFor(model, id)?.name ?? "Calendar";

const calendarOptions = (model: Model) =>
  calendarChoices(model).map((calendar) => ({
    value: calendar.id,
    label: calendar.name,
  }));

const allCalendars = "All calendars";

const newCalendarButton = (model: Model, h: H) =>
  button(
    {
      variant: "ghost",
      size: "icon-sm",
      rounded: true,
      ariaLabel: "New calendar",
      attributes: [h.Title("New calendar")],
      disabled: busy(model),
      onClick: Message.NewCalendar(),
      children: [plusIcon(h, "16")],
    },
    h,
  );

const calendarNavigation = (
  model: Model,
  surface: MenuTarget["surface"],
  h: H,
) => {
  const navigationLink = (id: string | null, label: string, color?: string) => {
    const current = id === model.visible;
    return h.a(
      [
        h.Href(calendarListPath(id)),
        h.DataAttribute("slot", "navigation-link"),
        h.Class(sidebarItemClassName(current)),
        ...(current ? [h.AriaCurrent("page")] : []),
      ],
      [
        h.span(
          [h.Class("calendar-nav-destination")],
          [
            ...(color
              ? [
                  h.span(
                    [
                      h.Class("calendar-nav-swatch"),
                      h.Style({ backgroundColor: color }),
                      h.AriaHidden(true),
                    ],
                    [],
                  ),
                ]
              : []),
            h.span([h.Class("calendar-nav-label"), h.Title(label)], [label]),
          ],
        ),
      ],
    );
  };

  return h.nav(
    [h.AriaLabel("Calendar navigation")],
    [
      ...(surface === "sidebar"
        ? [
            h.div(
              [h.Class("calendar-nav-header")],
              [h.h2([], ["Calendars"]), newCalendarButton(model, h)],
            ),
          ]
        : []),
      h.ul(
        [h.Class(sidebarClassNames.list)],
        [
          h.li([h.Key("all")], [navigationLink(null, allCalendars)]),
          ...calendarChoices(model).map((calendar) => {
            const target = { calendarId: calendar.id, surface };
            return h.li(
              [h.Key(calendar.id), h.Class("calendar-nav-row")],
              [
                navigationLink(calendar.id, calendar.name, calendar.color),
                menu.view(
                  {
                    model: menuModel(model, target),
                    label: `Actions for ${calendar.name}`,
                    trigger: ellipsisIcon(h),
                    disabled: busy(model),
                    toParentMessage: (message) =>
                      Message.GotMenuMessage({ target, message }),
                    items: [
                      {
                        action: "edit",
                        label: "Edit",
                        icon: outlineIcon(h, [
                          "m15 5 4 4M4 20l4-.8L20 7a2.1 2.1 0 0 0-3-3L4.8 16z",
                        ]),
                      },
                      {
                        action: "import",
                        label: "Import",
                        icon: outlineIcon(h, [
                          "M12 15V3m-4 4 4-4 4 4M4 15v5h16v-5",
                        ]),
                      },
                      {
                        action: "export",
                        label: "Export",
                        icon: outlineIcon(h, [
                          "M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5",
                        ]),
                      },
                    ],
                  },
                  h,
                ),
              ],
            );
          }),
        ],
      ),
    ],
  );
};

const calendarEditorView = (model: Model, h: H) => {
  const editor = model.calendarEditor!;
  const disabled = busy(model);
  return dialog(
    {
      title: editor.create ? "New calendar" : "Edit calendar",
      titleId: "calendar-editor-title",
      attributes: [
        h.OnMount(OpenCalendarDialog()),
        h.OnCancel(Message.ClosedPanel()),
      ],
      children: [
        ...(model.error ? [h.p([h.Role("alert")], [model.error])] : []),
        h.form(
          [h.OnSubmit(Message.SavedCalendar())],
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
                  h.Autofocus(true),
                  h.OnInput((name) => Message.ChangedName({ name })),
                ]),
              ],
            ),
            h.div(
              [h.Class("calendar-colour-field")],
              [
                h.span([], ["Colour"]),
                ColorPicker.view(
                  {
                    model: editor.picker,
                    label: "Calendar colour",
                    disabled,
                    toParentMessage: toColorPicker,
                  },
                  h,
                ),
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
                      editor.create ? "Create calendar" : "Save changes",
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
    },
    h,
  );
};

const isFrequency = Schema.is(CalendarFrequency);
const repeatOptions = [
  { label: "Does not repeat", value: "" },
  { label: "Daily", value: "daily" },
  { label: "Weekly", value: "weekly" },
  { label: "Monthly", value: "monthly" },
];

const eventEditorView = (model: Model, h: H) => {
  const editor = model.editor!;
  const { draft } = editor;
  const disabled = busy(model);
  const title =
    editor.scope === "series"
      ? "Edit series"
      : editor.scope === "occurrence"
        ? "Edit occurrence"
        : editor.revision
          ? "Edit event"
          : "New event";
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
          ...(field === "title" ? [h.Autofocus(true)] : []),
          h.OnInput((value) => Message.ChangedText({ field, value })),
          ...(type === "datetime-local" ? [h.Attribute("step", "1")] : []),
          ...(field === "title" || field === "location"
            ? [h.Maxlength(field === "title" ? 250 : 500)]
            : []),
        ]),
      ],
    );
  return dialog(
    {
      title,
      titleId: "calendar-event-editor-title",
      attributes: [
        h.OnMount(OpenCalendarDialog()),
        h.OnCancel(Message.ClosedEventEditor()),
      ],
      children: [
        ...(model.error ? [h.p([h.Role("alert")], [model.error])] : []),
        h.form(
          [h.OnSubmit(Message.SavedEvent())],
          [
            textInput("Title", "title", "text"),
            nativeSelect(
              {
                label: "Calendar",
                value: editor.calendarId,
                options: calendarOptions(model),
                disabled: disabled || editor.scope === "occurrence",
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
                  draft.allDay
                    ? "First day"
                    : editor.scope === "series"
                      ? "Series starts"
                      : "Starts",
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
            ...(editor.scope === "occurrence"
              ? []
              : [
                  nativeSelect(
                    {
                      label: "Repeat",
                      value: editor.repeat?.frequency ?? "",
                      options: repeatOptions,
                      disabled,
                      onChange: (value) =>
                        Message.ChangedFrequency({
                          frequency: isFrequency(value) ? value : null,
                        }),
                    },
                    h,
                  ),
                  ...(editor.repeat
                    ? [
                        h.label(
                          [h.Class("calendar-field")],
                          [
                            h.span([], ["Repeat until (optional)"]),
                            h.input([
                              h.Type("date"),
                              h.Value(editor.repeat.until ?? ""),
                              h.Disabled(disabled),
                              h.Min(draft.start.slice(0, 10)),
                              h.OnInput((until) =>
                                Message.ChangedRepeatEnd({ until }),
                              ),
                            ]),
                          ],
                        ),
                      ]
                    : []),
                ]),
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
            ...(draft.allDay || editor.repeat || editor.scope === "occurrence"
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
                      model.request?.kind === "save"
                        ? "Saving…"
                        : editor.scope === "series"
                          ? "Save series"
                          : "Save event",
                    ],
                  },
                  h,
                ),
                button(
                  {
                    variant: "ghost",
                    disabled,
                    onClick: Message.ClosedEventEditor(),
                    children: ["Cancel"],
                  },
                  h,
                ),
              ],
            ),
          ],
        ),
      ],
    },
    h,
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
                    onClick: Message.EditEvent({ series: false }),
                    children: [event.recurring ? "Edit occurrence" : "Edit"],
                  },
                  h,
                ),
              ]
            : []),
          ...(event.series
            ? [
                button(
                  {
                    variant: "ghost",
                    disabled,
                    onClick: Message.EditEvent({ series: true }),
                    children: ["Edit series"],
                  },
                  h,
                ),
              ]
            : []),
          ...(event.draft && !event.recurring && !model.confirmDelete
            ? [
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

const importView = (id: string, model: Model, h: H) => {
  const report = model.preview?.report;
  const disabled = busy(model);
  return dialog(
    {
      titleId: "calendar-import-title",
      title: `Import into ${calendarName(model, id)}`,
      attributes: [
        h.OnMount(OpenCalendarDialog()),
        h.OnCancel(Message.ClosedPanel()),
      ],
      children: [
        ...(model.error ? [h.p([h.Role("alert")], [model.error])] : []),
        report
          ? h.div(
              [h.Class("calendar-import-preview")],
              [
                h.p(
                  [],
                  [
                    `${report.available} ready to import · ${report.existing} already imported · ${report.total - report.available - report.existing} skipped`,
                  ],
                ),
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
                        children: ["Choose another file"],
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
                h.label(
                  [h.Class("calendar-field")],
                  [
                    h.span(
                      [],
                      [
                        `Calendar file (.ics, up to ${calendarImportLimitLabel})`,
                      ],
                    ),
                    h.input([
                      h.Type("file"),
                      h.Id(fileInput),
                      h.Required(true),
                      h.Accept(".ics,text/calendar"),
                      h.Disabled(disabled),
                      h.Autofocus(true),
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
    },
    h,
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
  const events =
    model.week?.events.filter(
      (event) => !model.visible || event.calendarId === model.visible,
    ) ?? [];
  const showCalendarNames = calendars.length > 1 && !model.visible;
  const missing =
    model.week !== null && model.visible !== null && !selectedCalendar;
  const list = h.div(
    [h.Class("workspace-list calendar")],
    [
      ...(model.error &&
      !model.importing &&
      !model.calendarEditor &&
      !model.editor
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
      ...(model.selected ? [detailsView(model, h)] : []),
      ...(model.calendarEditor ? [calendarEditorView(model, h)] : []),
      ...(model.editor ? [eventEditorView(model, h)] : []),
      ...(model.importing ? [importView(model.importing, model, h)] : []),
      ...(missing ? [h.p([h.Role("alert")], ["Calendar not found."])] : []),
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
      ...(model.week && !missing
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
                                      h.Style({
                                        "--calendar-event-color":
                                          calendarFor(model, event.calendarId)
                                            ?.color ?? defaultCalendarColor,
                                      }),
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
  return workspace(
    {
      className: "workspace-stacked calendar-workspace",
      title:
        model.visible === null
          ? allCalendars
          : (selectedCalendar?.name ?? "Calendar"),
      headerActions: [
        h.div(
          [h.Class("workspace-drawer-trigger")],
          [
            button(
              {
                variant: "ghost",
                size: "icon",
                rounded: true,
                ariaLabel: "Calendars",
                dialogId: model.folderSheet.id,
                disabled,
                onClick: toFolderSheet(Sheet.Message.RequestedOpen()),
                children: [outlineIcon(h, ["M4 6h16M4 12h16M4 18h16"])],
              },
              h,
            ),
          ],
        ),
        button(
          {
            size: "sm",
            disabled: disabled || (model.visible !== null && !selectedCalendar),
            onClick: Message.NewEvent({ day: eventDate }),
            children: ["New event"],
          },
          h,
        ),
      ],
      sidebar: calendarNavigation(model, "sidebar", h),
      list,
      hasSelection: false,
      sheet: Sheet.sheet(
        {
          model: model.folderSheet,
          title: "Calendars",
          headerActions: [newCalendarButton(model, h)],
          content: calendarNavigation(model, "sheet", h),
          toParentMessage: toFolderSheet,
        },
        h,
      ),
    },
    h,
  );
});
