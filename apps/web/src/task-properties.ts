import { Temporal } from "@js-temporal/polyfill";
import { CalendarPicker, MultiCombobox, Popover } from "@orumai/ui";
import { Schema } from "effect";
import { defaultEnglishLocale } from "foldkit/calendar";
import { ItemId } from "./items-contract.ts";

export const Property = Schema.Literals([
  "tagIds",
  "status",
  "priority",
  "assignee",
  "dueOn",
]);
export type Property = typeof Property.Type;
export const propertyLabels: Record<Property, string> = {
  tagIds: "Tags",
  status: "Status",
  priority: "Priority",
  assignee: "Assignee",
  dueOn: "Due date",
};

export const PickerTarget = Schema.Struct({
  id: ItemId,
  field: Property,
  surface: Schema.Literals(["detail", "row", "creation"]),
});
export type PickerTarget = typeof PickerTarget.Type;
export const pickerId = ({ id, field, surface }: PickerTarget) =>
  `task-${surface}-${field}-${id}`;

export const Picker = Schema.Struct({
  ...PickerTarget.fields,
  popover: Popover.Model,
  search: MultiCombobox.Model,
  calendar: Schema.NullOr(CalendarPicker.Model),
  today: Schema.String,
  calendarFocusing: Schema.Boolean,
});
export type Picker = typeof Picker.Type;

export const initPicker = (target: PickerTarget): Picker => {
  const id = pickerId(target);
  return {
    ...target,
    popover: Popover.init({ id }),
    search: MultiCombobox.init(`${id}-search`),
    calendar: null,
    calendarFocusing: false,
    today: Temporal.Now.plainDateISO().toString(),
  };
};

export const calendarDate = (value: string): CalendarPicker.CalendarDate => {
  const { year, month, day } = Temporal.PlainDate.from(value);
  return { year, month, day };
};
export const taskCalendar = (picker: Picker, dueOn: string | null) =>
  CalendarPicker.init({
    id: `${pickerId(picker)}-calendar`,
    today: calendarDate(picker.today),
    initialViewDate: calendarDate(dueOn ?? picker.today),
    locale: { ...defaultEnglishLocale, firstDayOfWeek: "Monday" },
  });

export const calendarChoice = "calendar";
export const clearChoice = "clear";
export const dueChoices = (localDate: string) => {
  const today = Temporal.PlainDate.from(localDate);
  return [
    { id: today.toString(), name: "Today" },
    { id: today.add({ days: 1 }).toString(), name: "Tomorrow" },
    { id: today.add({ days: 2 }).toString(), name: "In 2 days" },
    {
      id: today.add({ days: 7 - today.dayOfWeek }).toString(),
      name: "End of week",
    },
    { id: today.add({ days: 7 }).toString(), name: "In 1 week" },
  ].map(({ id, name }, index) => ({ id: `${index}:${id}`, name, date: id }));
};
