import { Temporal } from "@js-temporal/polyfill";
import {
  button,
  calendarIconPaths,
  CalendarPicker,
  checkbox,
  ColorPicker,
  Dialog,
  dialog,
  DropdownMenu,
  ellipsisIcon,
  field,
  input,
  nativeSelect,
  outlineIcon,
  plusIcon,
  Popover,
  Sheet,
  sidebarClassNames,
  sidebarItemClassName,
  textarea,
  toggleGroup,
  toolbar,
} from "@oneapp/ui";
import { Effect, Option, Queue, Schema, Stream } from "effect";
import { Command, Mount, Submodel, Update } from "foldkit";
import { defaultEnglishLocale } from "foldkit/calendar";
import { focus } from "foldkit/dom";
import type { ChildAttribute, HtmlBuilder } from "foldkit/html";
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
import {
  calendarSlotTimes,
  calendarTimelineDay,
  minutesInDay,
  slotMinutes,
} from "./calendar-timeline.ts";
import { settingsSectionPath } from "./settings-navigation.ts";
import { workspace, workspaceDrawerMedia } from "./workspace.ts";

const Surface = Schema.Literals(["sidebar", "sheet"]);
const MenuTarget = Schema.Struct({
  calendarId: CalendarId,
  surface: Surface,
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
  fromCreateMenu: Schema.Boolean,
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

const ScheduleView = Schema.Literals(["day", "week"]);
const Slot = Schema.Struct({ day: Schema.String, minute: Schema.Number });
const SelectedEvent = Schema.Struct({
  anchorId: Schema.String,
  event: CalendarOccurrence,
});

export const Model = Schema.Struct({
  date: Schema.String,
  view: ScheduleView,
  datePickers: Schema.Struct({
    sidebar: CalendarPicker.Model,
    sheet: CalendarPicker.Model,
  }),
  slotFocus: Schema.NullOr(Slot),
  zone: Schema.String,
  week: Schema.NullOr(CalendarWeek),
  calendars: Schema.Array(CalendarSummary),
  visible: Schema.NullOr(CalendarId),
  folderSheet: Sheet.Model,
  menus: Schema.Record(Schema.String, DropdownMenu.Model),
  calendarEditor: Schema.NullOr(CalendarEditor),
  request: Schema.NullOr(RequestState),
  selected: Schema.NullOr(SelectedEvent),
  editor: Schema.NullOr(Editor),
  confirmDelete: Schema.Boolean,
  importing: Schema.NullOr(CalendarId),
  preview: Schema.NullOr(ImportState),
  error: Schema.NullOr(Schema.String),
  notice: Schema.NullOr(Schema.String),
});
type Model = typeof Model.Type;
export const hasGlobalEventEditor = (model: Model) =>
  model.editor?.fromCreateMenu === true;
export const creationTitleId = "event-create-title-input";
const creationSubmitId = "event-create-submit";

const today = () => Temporal.Now.plainDateISO();
const pickerDate = ({
  year,
  month,
  day,
}: Temporal.PlainDate): CalendarPicker.CalendarDate => ({ year, month, day });
const weekStart = (date: string) => calendarWeekStart(calendarDate(date));
export const initial = (): Model => {
  const date = today();
  const picker = (surface: typeof Surface.Type) =>
    CalendarPicker.init({
      id: `calendar-date-${surface}`,
      today: pickerDate(date),
      locale: { ...defaultEnglishLocale, firstDayOfWeek: "Monday" },
    });
  return {
    date: date.toString(),
    view: globalThis.matchMedia?.(workspaceDrawerMedia).matches
      ? "day"
      : "week",
    datePickers: { sidebar: picker("sidebar"), sheet: picker("sheet") },
    slotFocus: null,
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
  };
};

export const Message = defineMessageUnion({
  Opened: { id: Schema.NullOr(CalendarId), refresh: Schema.Boolean },
  ShiftedPeriod: { direction: Schema.Literals([-1, 1]) },
  ChangedView: { view: ScheduleView },
  SelectedDate: { date: Schema.String },
  GotDatePicker: { surface: Surface, message: CalendarPicker.Message },
  JumpedToToday: {},
  Retried: {},
  GotFolderSheetMessage: { message: Sheet.Message },
  GotMenuMessage: { target: MenuTarget, message: DropdownMenu.Message },
  NewCalendar: {},
  DownloadStarted: {},
  ChangedName: { name: Schema.String },
  GotColorPicker: { message: ColorPicker.Message },
  SavedCalendar: {},
  OpenedEvent: SelectedEvent.fields,
  ClosedEventDetails: { anchorId: Schema.String },
  NewEvent: { day: Schema.String, minute: Schema.NullOr(Schema.Number) },
  OpenedCreate: { useCalendarContext: Schema.Boolean },
  FocusedSlot: { slot: Slot },
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
  ToggledAllDay: { checked: Schema.Boolean },
  ToggledReminder: { checked: Schema.Boolean },
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

const FocusEvent = Command.define("FocusCalendarEvent", {
  args: { anchorId: Schema.String },
  messages: [Message.Focused],
  execute: ({ anchorId }) =>
    Effect.sync(() => {
      document.getElementById(anchorId)?.focus({ preventScroll: true });
      return Message.Focused();
    }),
});

const FocusCreateSubmit = Command.define("FocusEventCreateSubmit", {
  messages: [Message.Focused],
  execute: focus(`#${creationSubmitId}`).pipe(
    Effect.ignore,
    Effect.as(Message.Focused()),
  ),
});

const MountEventDetails = Mount.defineStream("MountCalendarEventDetails", {
  args: { anchorId: Schema.String },
  messages: [Message.ClosedEventDetails],
  execute: ({ element, anchorId }) =>
    Stream.callback<typeof Message.ClosedEventDetails.Type>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const cleanup = Popover.anchorSetup(element, {
            buttonId: anchorId,
            anchor: { placement: "bottom-start", gap: 6, padding: 8 },
            interceptTab: false,
            focusAfterPosition: true,
          });
          const dismiss = (event: Event) => {
            if (
              document.querySelector(
                'dialog:modal, dialog[open][aria-modal="true"]',
              )
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            Queue.offerUnsafe(queue, Message.ClosedEventDetails({ anchorId }));
          };
          const clickOutside = (event: MouseEvent) => {
            const target = event.target;
            if (
              target instanceof Element &&
              !element.contains(target) &&
              !target.closest('[data-slot="calendar-event"]')
            ) {
              dismiss(event);
            }
          };
          const pressEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") dismiss(event);
          };
          document.addEventListener("click", clickOutside, true);
          document.addEventListener("keydown", pressEscape, true);
          return () => {
            document.removeEventListener("click", clickOutside, true);
            document.removeEventListener("keydown", pressEscape, true);
            cleanup();
          };
        }),
        (cleanup) => Effect.sync(cleanup),
      ),
    ),
});

const ScrollTimeline = Mount.define("ScrollCalendarTimeline", {
  args: { minute: Schema.Number },
  messages: [Message.Focused],
  execute: ({ element, minute }) =>
    Effect.sync(() => {
      if (element instanceof HTMLElement) {
        const hours = element.querySelector<HTMLElement>(".calendar-hours");
        if (hours)
          element.scrollTop = (hours.offsetHeight * minute) / minutesInDay;
      }
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
): Update.ReturnWithOutMessage<Model, Message, never> => {
  const id = crypto.randomUUID();
  return {
    model: { ...model, error: null, request: { id, kind: "load" } },
    commands: [
      LoadWeek({ id, start: weekStart(model.date), zone: model.zone }),
    ],
  };
};

const navigateDate = (model: Model, date: string) => {
  const focus = (picker: typeof CalendarPicker.Model.Type) =>
    CalendarPicker.dropToDays(
      CalendarPicker.focusDate(picker, pickerDate(calendarDate(date))),
    );
  const next = {
    ...model,
    ...closedPanel,
    date,
    datePickers: {
      sidebar: focus(model.datePickers.sidebar),
      sheet: focus(model.datePickers.sheet),
    },
    slotFocus: null,
    notice: null,
  };
  if (weekStart(date) !== weekStart(model.date))
    return load({ ...next, week: null });
  return !next.week && !next.request ? load(next) : { model: next };
};

const busy = (model: Model) =>
  model.request !== null && model.request.kind !== "load";
const openPanel = (model: Model, panel: Partial<Model>) => ({
  model: { ...model, ...closedPanel, error: null, notice: null, ...panel },
});

const openNewEvent = (
  model: Model,
  {
    day,
    minute,
    calendarId,
    fromCreateMenu = false,
  }: {
    day: string;
    minute: number | null;
    calendarId: string | null;
    fromCreateMenu?: boolean;
  },
) =>
  openPanel(model, {
    editor: {
      id: crypto.randomUUID(),
      calendarId: calendarId ?? defaultCalendarId,
      revision: null,
      repeat: null,
      scope: "event",
      occurrence: null,
      fromCreateMenu,
      draft: {
        title: "",
        location: "",
        description: "",
        allDay: false,
        ...(minute === null
          ? { start: `${day}T09:00`, end: `${day}T10:00` }
          : calendarSlotTimes(day, minute, model.zone)),
        timeZone: model.zone,
        reminder: false,
      },
    },
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

const foldDatePicker = Update.foldChildAt({
  update: CalendarPicker.update,
  readAt: (model: Model, surface: typeof Surface.Type) =>
    Option.some(model.datePickers[surface]),
  writeAt: (model, surface, picker) => ({
    ...model,
    datePickers: { ...model.datePickers, [surface]: picker },
  }),
  toParentMessage: (surface, message) =>
    Message.GotDatePicker({ surface, message }),
  foldOutMessage:
    (surface) =>
    (out): Update.Step<Model, Message> =>
    (model) => {
      if (out._tag !== "SelectedDate") return { model };
      const date = Temporal.PlainDate.from(out.date).toString();
      return surface === "sheet"
        ? Update.combine(model, [
            (model) => navigateDate(model, date),
            (model) => updateFolderSheet(model, Sheet.Message.RequestedClose()),
          ])
        : navigateDate(model, date);
    },
});

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
      ShiftedPeriod: ({ direction }) =>
        busy(model)
          ? { model }
          : navigateDate(
              model,
              calendarDays(
                model.date,
                direction * (model.view === "week" ? 7 : 1),
              ),
            ),
      ChangedView: ({ view }) =>
        busy(model) || model.view === view
          ? { model }
          : {
              model: {
                ...model,
                view,
                slotFocus: null,
                selected: null,
                confirmDelete: false,
              },
            },
      SelectedDate: ({ date }) =>
        busy(model) ? { model } : navigateDate(model, date),
      GotDatePicker: ({ surface, message }) =>
        busy(model) ? { model } : foldDatePicker(model, surface, message),
      JumpedToToday: () =>
        busy(model) ? { model } : navigateDate(model, today().toString()),
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
      OpenedEvent: ({ anchorId, event }) =>
        busy(model) || model.selected?.anchorId === anchorId
          ? { model }
          : {
              model: {
                ...model,
                selected: { anchorId, event },
                confirmDelete: false,
              },
            },
      ClosedEventDetails: ({ anchorId }) =>
        model.selected?.anchorId !== anchorId || model.editor
          ? { model }
          : {
              model: { ...model, selected: null, confirmDelete: false },
              commands: [FocusEvent({ anchorId })],
            },
      NewEvent: ({ day, minute }) =>
        busy(model)
          ? { model }
          : openNewEvent(model, { day, minute, calendarId: model.visible }),
      OpenedCreate: ({ useCalendarContext }) => {
        if (busy(model)) return { model };
        const result = openNewEvent(model, {
          day: useCalendarContext ? model.date : today().toString(),
          minute: null,
          calendarId: useCalendarContext ? model.visible : null,
          fromCreateMenu: true,
        });
        return !model.week && !model.request ? load(result.model) : result;
      },
      FocusedSlot: ({ slot }) => ({ model: { ...model, slotFocus: slot } }),
      EditEvent: ({ series }) => {
        const event = model.selected?.event;
        const draft = series ? event?.series?.draft : event?.draft;
        if (!event || !draft || busy(model)) return { model };
        return openPanel(model, {
          selected: model.selected,
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
            fromCreateMenu: false,
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
      ToggledAllDay: ({ checked: allDay }) => {
        const editor = model.editor;
        if (!editor || busy(model) || editor.draft.allDay === allDay)
          return { model };
        const draft = editor.draft;
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
      ToggledReminder: ({ checked }) => {
        const editor = model.editor;
        if (!editor || busy(model)) return { model };
        return {
          model: {
            ...model,
            editor: {
              ...editor,
              draft: { ...editor.draft, reminder: checked },
            },
          },
        };
      },
      SavedEvent: () => {
        if (!model.editor || busy(model)) return { model };
        const id = crypto.randomUUID();
        return {
          model: { ...model, error: null, request: { id, kind: "save" } },
          commands: [
            ...(hasGlobalEventEditor(model) ? [FocusCreateSubmit()] : []),
            SaveEvent({ id, editor: model.editor }),
          ],
        };
      },
      ClosedEventEditor: () =>
        busy(model)
          ? { model }
          : { model: { ...model, editor: null, error: null } },
      RequestedDelete: () =>
        busy(model) ? { model } : { model: { ...model, confirmDelete: true } },
      ConfirmedDelete: () => {
        const event = model.selected?.event;
        if (!event?.draft || event.recurring || busy(model)) return { model };
        const id = crypto.randomUUID();
        return {
          model: { ...model, error: null, request: { id, kind: "delete" } },
          commands: [
            DeleteEvent({
              id,
              eventId: event.id,
              revision: event.revision,
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
          : afterMutation(
              model,
              notice,
              model.visible && !hasGlobalEventEditor(model) ? calendarId : null,
            ),
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
            color
              ? h.span(
                  [
                    h.Class("calendar-nav-swatch"),
                    h.Style({ backgroundColor: color }),
                    h.AriaHidden(true),
                  ],
                  [],
                )
              : outlineIcon(h, calendarIconPaths),
            h.span([h.Class("calendar-nav-label"), h.Title(label)], [label]),
          ],
        ),
      ],
    );
  };

  return h.nav(
    [h.AriaLabel("Calendar navigation")],
    [
      CalendarPicker.view(
        {
          model: model.datePickers[surface],
          selectedDate: pickerDate(calendarDate(model.date)),
          weekStart:
            model.view === "week"
              ? pickerDate(calendarDate(weekStart(model.date)))
              : null,
          toParentMessage: (message) =>
            Message.GotDatePicker({ surface, message }),
        },
        h,
      ),
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
            field(
              "Calendar name",
              input(
                [
                  h.Type("text"),
                  h.Value(editor.name),
                  h.Required(true),
                  h.Maxlength(calendarNameLimit),
                  h.Disabled(disabled),
                  h.Autofocus(true),
                  h.OnInput((name) => Message.ChangedName({ name })),
                ],
                h,
              ),
              h,
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

const eventEditorContent = (
  model: Model,
  h: H,
  initialFocus?: ReadonlyArray<ChildAttribute>,
) => {
  const editor = model.editor!;
  const { draft } = editor;
  const disabled = busy(model);
  const saving = model.request?.kind === "save";
  const save = button(
    {
      type: "submit",
      disabled,
      ...(editor.fromCreateMenu
        ? {
            attributes: [h.Id(creationSubmitId)],
            focusableWhenDisabled: saving,
          }
        : {}),
      children: [
        saving
          ? "Saving…"
          : editor.scope === "series"
            ? "Save series"
            : "Save event",
      ],
    },
    h,
  );
  const cancel = button(
    {
      variant: "ghost",
      disabled,
      onClick: Message.ClosedEventEditor(),
      children: ["Cancel"],
    },
    h,
  );
  const draftInput = (
    label: string,
    key: "title" | "location" | "start" | "end",
    type: "text" | "date" | "datetime-local",
  ) =>
    field(
      label,
      input(
        [
          h.Type(type),
          h.Value(draft[key]),
          h.Required(key !== "location"),
          h.Disabled(disabled),
          h.OnInput((value) => Message.ChangedText({ field: key, value })),
          ...(key === "title"
            ? [
                h.Maxlength(250),
                ...(initialFocus
                  ? [h.Id(creationTitleId), ...initialFocus]
                  : [h.Autofocus(true)]),
              ]
            : []),
          ...(key === "location" ? [h.Maxlength(500)] : []),
          ...(type === "datetime-local" ? [h.Step("1")] : []),
        ],
        h,
      ),
      h,
    );
  return [
    ...(model.error ? [h.p([h.Role("alert")], [model.error])] : []),
    h.form(
      [h.OnSubmit(Message.SavedEvent())],
      [
        draftInput("Title", "title", "text"),
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
        checkbox(
          {
            id: "calendar-event-all-day",
            label: "All day",
            checked: draft.allDay,
            disabled,
            onToggle: (checked) => Message.ToggledAllDay({ checked }),
          },
          h,
        ),
        h.div(
          [h.Class("calendar-form-dates")],
          [
            draftInput(
              draft.allDay
                ? "First day"
                : editor.scope === "series"
                  ? "Series starts"
                  : "Starts",
              "start",
              draft.allDay ? "date" : "datetime-local",
            ),
            draftInput(
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
                    field(
                      "Repeat until (optional)",
                      input(
                        [
                          h.Type("date"),
                          h.Value(editor.repeat.until ?? ""),
                          h.Disabled(disabled),
                          h.Min(draft.start.slice(0, 10)),
                          h.OnInput((until) =>
                            Message.ChangedRepeatEnd({ until }),
                          ),
                        ],
                        h,
                      ),
                      h,
                    ),
                  ]
                : []),
            ]),
        draftInput("Location", "location", "text"),
        field(
          "Notes",
          textarea(
            [
              h.Value(draft.description),
              h.Maxlength(8000),
              h.Disabled(disabled),
              h.OnInput((value) =>
                Message.ChangedText({ field: "description", value }),
              ),
            ],
            h,
          ),
          h,
        ),
        ...(draft.allDay || editor.repeat || editor.scope === "occurrence"
          ? []
          : [
              checkbox(
                {
                  id: "calendar-event-reminder",
                  label: `Remind me ${calendarReminderMinutes} minutes before`,
                  checked: draft.reminder,
                  disabled,
                  onToggle: (checked) => Message.ToggledReminder({ checked }),
                },
                h,
              ),
              ...(!model.week?.remindersAvailable
                ? [
                    h.p(
                      [h.Class("calendar-muted")],
                      [
                        "Set up notifications on a device in ",
                        h.a(
                          [h.Href(settingsSectionPath("notifications"))],
                          ["Settings"],
                        ),
                        ".",
                      ],
                    ),
                  ]
                : []),
            ]),
        editor.fromCreateMenu
          ? Dialog.footer([cancel, save], h)
          : h.div([h.Class("calendar-actions")], [save, cancel]),
      ],
    ),
  ];
};

export const createView = Submodel.defineView(
  (model: Model, initialFocus: ReadonlyArray<ChildAttribute>, h: H) =>
    hasGlobalEventEditor(model)
      ? h.div([], eventEditorContent(model, h, initialFocus))
      : h.empty,
);

const eventEditorView = (model: Model, h: H) => {
  const editor = model.editor!;
  const title =
    editor.scope === "series"
      ? "Edit series"
      : editor.scope === "occurrence"
        ? "Edit occurrence"
        : editor.revision
          ? "Edit event"
          : "New event";
  return dialog(
    {
      title,
      titleId: "calendar-event-editor-title",
      attributes: [
        h.OnMount(OpenCalendarDialog()),
        h.OnCancel(Message.ClosedEventEditor()),
      ],
      children: eventEditorContent(model, h),
    },
    h,
  );
};

const eventDetailsId = "calendar-event-details";
const eventDetailsTitleId = `${eventDetailsId}-title`;

const detailsView = (
  { anchorId, event }: typeof SelectedEvent.Type,
  model: Model,
  h: H,
) => {
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
    [
      h.Key(anchorId),
      h.Id(eventDetailsId),
      h.Class("calendar-event-popover"),
      h.Role("dialog"),
      h.AriaLabelledBy(eventDetailsTitleId),
      h.Tabindex(-1),
      h.OnMount(MountEventDetails({ anchorId })),
    ],
    [
      h.h2([h.Id(eventDetailsTitleId)], [event.title]),
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
              onClick: Message.ClosedEventDetails({ anchorId }),
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
                field(
                  `Calendar file (.ics, up to ${calendarImportLimitLabel})`,
                  input(
                    [
                      h.Type("file"),
                      h.Id(fileInput),
                      h.Required(true),
                      h.Accept(".ics,text/calendar"),
                      h.Disabled(disabled),
                      h.Autofocus(true),
                    ],
                    h,
                  ),
                  h,
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

const viewChoices = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
] as const;

const scheduleTitle = (view: Model["view"], days: readonly string[]) => {
  const first = days[0]!;
  const last = days.at(-1)!;
  const crossYear = calendarDate(first).year !== calendarDate(last).year;
  const period = (day: string) =>
    plain(day, {
      month: "short",
      day: "numeric",
      ...(crossYear ? { year: "numeric" } : {}),
    });
  return view === "day"
    ? plain(first, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : `${period(first)} – ${period(last)}${crossYear ? "" : ` · ${calendarDate(last).year}`}`;
};

const scheduleControls = (view: Model["view"], disabled: boolean, h: H) => {
  const shift = (direction: -1 | 1) =>
    button(
      {
        variant: "ghost",
        size: "icon-sm",
        disabled,
        ariaLabel: `${direction === -1 ? "Previous" : "Next"} ${view}`,
        onClick: Message.ShiftedPeriod({ direction }),
        children: [
          outlineIcon(h, [
            direction === -1 ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6",
          ]),
        ],
      },
      h,
    );
  return toolbar(
    {
      label: "Schedule controls",
      start: [
        h.div(
          [h.Class("calendar-period-controls")],
          [
            shift(-1),
            button(
              {
                variant: "ghost",
                size: "sm",
                disabled,
                onClick: Message.JumpedToToday(),
                children: ["Today"],
              },
              h,
            ),
            shift(1),
          ],
        ),
      ],
      end: [
        toggleGroup(
          {
            label: "Calendar view",
            value: view,
            items: viewChoices,
            disabled,
            onToggle: (view) => Message.ChangedView({ view }),
          },
          h,
        ),
      ],
    },
    h,
  );
};

const hours = Array.from({ length: 24 }, (_, hour) => hour * 60);
const timeAt = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});
const timeLabel = (minute: number) =>
  timeAt.format(Date.UTC(2000, 0, 1, 0, minute));
const slotId = ({ day, minute }: typeof Slot.Type) =>
  `calendar-slot-${day}-${minute}`;
const percent = (minute: number) => `${(minute * 100) / minutesInDay}%`;

const schedule = (
  model: Model,
  days: readonly string[],
  events: readonly CalendarOccurrence[],
  current: string,
  h: H,
) => {
  const timeline = days.map((day) => ({
    day,
    ...calendarTimelineDay(events, day, model.zone),
  }));
  const focusedDay = timeline.find(({ day }) => day === model.date)!;
  const focus = model.slotFocus ?? {
    day: model.date,
    minute:
      focusedDay.slots.find((minute) => minute >= 9 * 60) ??
      focusedDay.slots[0],
  };
  const start = Math.min(
    8 * 60,
    ...timeline.flatMap(({ timed }) =>
      timed.slice(0, 1).map((item) => item.start),
    ),
  );
  const disabled = busy(model);

  const eventButton = (
    day: string,
    event: CalendarOccurrence,
    time: string,
    accessibleTime: string,
    placement?: { start: number; end: number; lane: number; lanes: number },
  ) => {
    const name = calendarName(model, event.calendarId);
    const label = [event.title, accessibleTime, name].join(", ");
    const anchorId = `calendar-event-${day}-${event.id}-${event.occurrence}`;
    const expanded = model.selected?.anchorId === anchorId && !model.editor;
    return h.button(
      [
        h.Key(`${event.id}:${event.occurrence}`),
        h.Id(anchorId),
        h.Type("button"),
        h.Class("calendar-event"),
        h.DataAttribute("slot", "calendar-event"),
        h.AriaLabel(label),
        h.AriaHasPopup("dialog"),
        h.AriaExpanded(expanded),
        ...(expanded ? [h.AriaControls(eventDetailsId)] : []),
        h.Title(label),
        h.Style({
          "--calendar-event-color":
            calendarFor(model, event.calendarId)?.color ?? defaultCalendarColor,
          ...(placement
            ? {
                "--event-top": percent(placement.start),
                "--event-height": percent(placement.end - placement.start),
                "--event-offset": `${(placement.lane * 100) / placement.lanes}%`,
                "--event-width": `${100 / placement.lanes}%`,
              }
            : {}),
        }),
        h.Disabled(disabled),
        h.OnClick(Message.OpenedEvent({ anchorId, event })),
      ],
      [
        h.span([h.Class("calendar-event-title")], [event.title]),
        ...(time ? [h.span([h.Class("calendar-event-time")], [time])] : []),
      ],
    );
  };

  return h.div(
    [
      h.Key("calendar-timeline"),
      h.Class("calendar-timeline-scroll"),
      h.OnMount(
        ScrollTimeline({
          minute: Math.max(6 * 60, Math.floor(start / 60) * 60),
        }),
      ),
      h.AriaLabel(model.view === "week" ? "Week schedule" : "Day schedule"),
      h.Role("region"),
    ],
    [
      h.div(
        [
          h.Class("calendar-timeline"),
          h.DataAttribute("view", model.view),
          h.Style({ "--calendar-days": String(days.length) }),
        ],
        [
          h.div(
            [h.Class("calendar-timeline-header")],
            [
              ...(model.view === "week"
                ? [
                    h.div(
                      [h.Class("calendar-timeline-row calendar-dates")],
                      [
                        h.span(
                          [h.Class("calendar-time-gutter"), h.AriaHidden(true)],
                          [],
                        ),
                        ...days.map((day) => {
                          const date = calendarDate(day);
                          return h.button(
                            [
                              h.Key(day),
                              h.Type("button"),
                              h.DataAttribute("slot", "calendar-date"),
                              h.DataAttribute(
                                "selected",
                                String(day === model.date),
                              ),
                              ...(day === current
                                ? [h.AriaCurrent("date")]
                                : []),
                              h.AriaPressed(String(day === model.date)),
                              h.AriaLabel(plain(day, { dateStyle: "full" })),
                              h.Disabled(disabled),
                              h.OnClick(Message.SelectedDate({ date: day })),
                            ],
                            [
                              h.span([], [plain(day, { weekday: "short" })]),
                              h.span(
                                [h.Class("calendar-date-number")],
                                [date.day.toString()],
                              ),
                            ],
                          );
                        }),
                      ],
                    ),
                  ]
                : []),
              h.div(
                [h.Class("calendar-timeline-row calendar-all-day")],
                [
                  h.span([h.Class("calendar-time-gutter")], ["All day"]),
                  ...timeline.map(({ day, allDay }) =>
                    h.div(
                      [h.Key(day), h.Class("calendar-all-day-events")],
                      allDay.map((event) =>
                        eventButton(
                          day,
                          event,
                          "",
                          `All day, ${plain(day, { dateStyle: "full" })}`,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
          h.div(
            [h.Class("calendar-timeline-row calendar-hours")],
            [
              h.div(
                [
                  h.Class("calendar-time-gutter calendar-axis"),
                  h.AriaHidden(true),
                ],
                hours.map((minute) =>
                  h.span(
                    [h.Style({ top: percent(minute) })],
                    [timeLabel(minute)],
                  ),
                ),
              ),
              ...timeline.map(({ day, timed, slots }, dayIndex) => {
                const dateLabel = plain(day, { dateStyle: "full" });
                return h.div(
                  [
                    h.Key(day),
                    h.Class("calendar-time-column"),
                    h.AriaLabel(dateLabel),
                    h.Role("group"),
                  ],
                  [
                    ...slots.map((minute, index) => {
                      const slot = { day, minute };
                      return h.button(
                        [
                          h.Key(String(minute)),
                          h.Id(slotId(slot)),
                          h.Type("button"),
                          h.DataAttribute("slot", "calendar-time-slot"),
                          h.AriaLabel(
                            `New event, ${dateLabel}, ${timeLabel(minute)}`,
                          ),
                          h.Style({
                            top: percent(minute),
                            height: percent(slotMinutes),
                          }),
                          h.Tabindex(
                            focus.day === day && focus.minute === minute
                              ? 0
                              : -1,
                          ),
                          h.Disabled(disabled),
                          h.OnClick(Message.NewEvent(slot)),
                          h.OnKeyDownFocus((key) => {
                            const column =
                              timeline[
                                dayIndex + (key === "ArrowLeft" ? -1 : 1)
                              ];
                            const target =
                              key === "ArrowUp"
                                ? slots[index - 1]
                                : key === "ArrowDown"
                                  ? slots[index + 1]
                                  : key === "Home"
                                    ? slots[0]
                                    : key === "End"
                                      ? slots.at(-1)
                                      : undefined;
                            const otherDay =
                              (key === "ArrowLeft" || key === "ArrowRight") &&
                              column;
                            const adjacent = otherDay
                              ? (column.slots.find(
                                  (value) => value >= minute,
                                ) ?? column.slots.at(-1))
                              : undefined;
                            const next =
                              adjacent !== undefined && column
                                ? { day: column.day, minute: adjacent }
                                : target !== undefined
                                  ? { day, minute: target }
                                  : null;
                            return next
                              ? Option.some({
                                  focusSelector: `#${slotId(next)}`,
                                  message: Message.FocusedSlot({ slot: next }),
                                })
                              : Option.none();
                          }),
                        ],
                        [],
                      );
                    }),
                    ...timed.map((item) => {
                      const event = item.event;
                      const start = clock(event.start, model.zone);
                      const end = clock(event.end, model.zone);
                      return eventButton(
                        day,
                        event,
                        item.continues ? "Continues" : start,
                        `${dateLabel}, ${item.continues ? "continues until " + end : start + " – " + end}`,
                        item,
                      );
                    }),
                  ],
                );
              }),
            ],
          ),
        ],
      ),
    ],
  );
};

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const current = today().toString();
  const days =
    model.view === "day"
      ? [model.date]
      : Array.from({ length: 7 }, (_, offset) =>
          calendarDays(weekStart(model.date), offset),
        );
  const disabled = busy(model);
  const calendars = calendarChoices(model);
  const selectedCalendar = calendars.find(
    (calendar) => calendar.id === model.visible,
  );
  const events =
    model.week?.events.filter(
      (event) => !model.visible || event.calendarId === model.visible,
    ) ?? [];
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
      ...(model.calendarEditor ? [calendarEditorView(model, h)] : []),
      ...(model.importing ? [importView(model.importing, model, h)] : []),
      ...(missing ? [h.p([h.Role("alert")], ["Calendar not found."])] : []),
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
        ? [schedule(model, days, events, current, h)]
        : []),
      ...(model.editor && !hasGlobalEventEditor(model)
        ? [eventEditorView(model, h)]
        : []),
      ...(model.selected && !model.editor
        ? [detailsView(model.selected, model, h)]
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
      titleAccessory: h.span(
        [h.Class("calendar-date-range"), h.AriaLive("polite")],
        [scheduleTitle(model.view, days)],
      ),
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
        h.div(
          [h.Class("calendar-header-actions")],
          [
            scheduleControls(model.view, disabled, h),
            button(
              {
                size: "sm",
                disabled:
                  disabled || (model.visible !== null && !selectedCalendar),
                onClick: Message.NewEvent({ day: model.date, minute: null }),
                children: ["New event"],
              },
              h,
            ),
          ],
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
