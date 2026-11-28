import { Temporal } from "@js-temporal/polyfill";
import {
  avatar,
  calendarIconPaths,
  CalendarPicker,
  circleCheckIconPaths,
  circleDashedIconPaths,
  circleDotDashedIconPaths,
  circleXIconPaths,
  clockIconPaths,
  flameIconPaths,
  MultiCombobox,
  outlineIcon,
  Popover,
  signalHighIconPaths,
  signalLowIconPaths,
  signalMediumIconPaths,
  userCheckIconPaths,
} from "@orumai/ui";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { Tag } from "./items-contract.ts";
import { tagProperty } from "./tag-picker-view.ts";
import { profileAvatar } from "./people.ts";
import type { PersonSummary } from "./people-contract.ts";
import {
  calendarChoice,
  calendarDate,
  clearChoice,
  dueChoices,
  pickerId,
  type PickerTarget,
  propertyLabels,
} from "./task-properties.ts";
import { type Task, taskPriorities, taskStatuses } from "./tasks-contract.ts";
import { creationFieldsLocked, Message, type Model } from "./tasks.ts";

export type ViewInputs = { owner: PersonSummary | null; ownerEmail: string };
export type TaskRowValue = { label: string; icon: readonly string[] };

const statusDisplay = {
  "not-started": { label: "Not started", icon: circleDotDashedIconPaths },
  "in-progress": { label: "In progress", icon: clockIconPaths },
  "in-review": { label: "In review", icon: userCheckIconPaths },
  completed: { label: "Complete", icon: circleCheckIconPaths },
  canceled: { label: "Cancelled", icon: circleXIconPaths },
} satisfies Record<Task["status"], TaskRowValue>;
const priorityDisplay = {
  "": { label: "No priority", icon: circleDashedIconPaths },
  low: { label: "Low", icon: signalLowIconPaths },
  medium: { label: "Medium", icon: signalMediumIconPaths },
  high: { label: "High", icon: signalHighIconPaths },
  urgent: { label: "Urgent", icon: flameIconPaths },
} satisfies Record<NonNullable<Task["priority"]> | "", TaskRowValue>;
const assigneeLabels = { owner: "Me", oru: "Oru", "": "Unassigned" };

export const statusOptions = taskStatuses.map((value) => ({
  value,
  label: statusDisplay[value].label,
}));
export const priorityOptions = (["", ...taskPriorities] as const).map(
  (value) => ({
    value,
    label: priorityDisplay[value].label,
  }),
);
export const assigneeOptions = (["owner", "oru", ""] as const).map((value) => ({
  value,
  label: assigneeLabels[value],
}));

const chevron = ["m7 10 5 5 5-5"];

const dateLabel = (date: string) => {
  const day = Temporal.PlainDate.from(date);
  const year =
    day.year === Temporal.Now.plainDateISO().year ? undefined : "numeric";
  return day.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year,
  });
};

const assigneeAvatar = (
  assignee: Task["assignee"],
  { owner, ownerEmail }: ViewInputs,
  h: HtmlBuilder<Message>,
) => {
  const imageMounted = Message.CompletedAssigneeAvatarImageMount();
  return assignee === "owner"
    ? profileAvatar(h, owner, ownerEmail, { imageMounted, size: "sm" })
    : avatar(
        {
          size: "sm",
          fallback:
            assignee === "oru"
              ? h.span([h.Class("task-assignee-mark")], [])
              : "",
          src: null,
          imageMounted,
        },
        h,
      );
};

const valueContent = (
  field: PickerTarget["field"],
  value: string,
  media: Html,
  label: Html | string,
  h: HtmlBuilder<Message>,
) =>
  h.span(
    [
      h.Class("task-row-value"),
      h.DataAttribute(
        field === "dueOn" ? "due-on" : field === "tagIds" ? "tag-ids" : field,
        value,
      ),
    ],
    [media, h.span([h.Class("task-property-label")], [label])],
  );

const propertyOptions = {
  status: statusOptions,
  priority: priorityOptions,
  assignee: assigneeOptions,
};
const propertyMedia = (
  field: keyof typeof propertyOptions,
  value: string,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
) => {
  if (field === "assignee")
    return assigneeAvatar(
      value === "owner" || value === "oru" ? value : null,
      inputs,
      h,
    );
  const displays: Readonly<Record<string, TaskRowValue>> =
    field === "status" ? statusDisplay : priorityDisplay;
  return outlineIcon(h, displays[value]!.icon);
};

export const taskProperty = (
  model: Model,
  task: Pick<Task, "id" | PickerTarget["field"]>,
  field: PickerTarget["field"],
  surface: PickerTarget["surface"],
  tags: readonly Tag[],
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
) => {
  const target = { id: task.id, field, surface };
  const id = pickerId(target);
  const picker =
    model.picker && pickerId(model.picker) === id ? model.picker : null;
  if (field === "tagIds")
    return tagProperty(
      {
        id,
        picker,
        tags,
        tagIds: task.tagIds,
        item: "task",
        row: surface === "row",
        disabled:
          surface === "creation" &&
          (creationFieldsLocked(model) || !model.index),
        creatingDisabled: model.request !== null,
        error: model.tagPickerError,
        toPopoverMessage: (message) =>
          Message.GotPropertyPopover({ target, message }),
        toSearchMessage: (message) =>
          Message.GotPropertySearch({ target, message }),
      },
      h,
    );
  const open = picker?.popover.isOpen ?? false;
  const label = propertyLabels[field];
  let displayed: string;
  let trigger: Html;
  let selectedValues: readonly string[] = [];
  const options: Array<{
    id: string;
    name: string;
    content?: Html;
    disabled?: boolean;
  }> = [];
  const placeholder = {
    status: "Search statuses",
    priority: "Search priorities",
    assignee: "Search assignees",
    dueOn: "",
  }[field];
  if (field === "dueOn") {
    displayed = task.dueOn ? dateLabel(task.dueOn) : "Set due date";
    trigger = valueContent(
      field,
      task.dueOn ?? "",
      outlineIcon(h, calendarIconPaths),
      displayed,
      h,
    );
    if (picker && open) {
      const dates = dueChoices(picker.today);
      selectedValues = [
        dates.find(({ date }) => date === task.dueOn)?.id ?? "",
      ];
      options.push(
        ...dates.map(({ id, name, date }) => ({
          id,
          name,
          content: h.span(
            [h.Class("task-date-choice")],
            [h.span([], [name]), h.span([], [dateLabel(date)])],
          ),
        })),
        { id: calendarChoice, name: "Pick from calendar…" },
      );
      if (task.dueOn) options.push({ id: clearChoice, name: "Clear date" });
    }
  } else {
    const choices = propertyOptions[field];
    const value = task[field] ?? "";
    displayed = choices.find((choice) => choice.value === value)!.label;
    trigger = valueContent(
      field,
      value,
      propertyMedia(field, value, inputs, h),
      displayed,
      h,
    );
    selectedValues = [value];
    if (picker && open) {
      const query = picker.search.inputValue.trim().toLocaleLowerCase();
      for (const choice of choices) {
        if (!choice.label.toLocaleLowerCase().includes(query)) continue;
        options.push({
          id: choice.value,
          name: choice.label,
          content: valueContent(
            field,
            choice.value,
            propertyMedia(field, choice.value, inputs, h),
            choice.label,
            h,
          ),
        });
      }
    }
  }
  const content =
    !picker || !open
      ? h.empty
      : picker.calendar
        ? CalendarPicker.view(
            {
              model: picker.calendar,
              selectedDate: task.dueOn ? calendarDate(task.dueOn) : null,
              weekStart: null,
              toParentMessage: (message) =>
                Message.GotPropertyCalendar({ target, message }),
            },
            h,
          )
        : h.div(
            [],
            [
              MultiCombobox.view(
                {
                  model: picker.search,
                  items: options,
                  selectedValues,
                  single: true,
                  searchable: field !== "dueOn",
                  label: field === "dueOn" ? label : placeholder,
                  placeholder,
                  emptyMessage: "No matching options.",
                  toParentMessage: (message) =>
                    Message.GotPropertySearch({ target, message }),
                },
                h,
              ),
            ],
          );
  return Popover.view(
    {
      model: picker?.popover ?? Popover.init({ id }),
      label,
      triggerLabel: `${label}: ${displayed}`,
      disabled: surface === "creation" && creationFieldsLocked(model),
      triggerButton: {
        variant: surface === "row" ? "quiet" : "ghost",
        size: "sm",
      },
      triggerClassName: `task-property-trigger task-property-${field}`,
      triggerAttributes: [h.Title(`${label}: ${displayed}`)],
      trigger: h.span(
        [h.Class("task-property-content")],
        [
          trigger,
          h.span([h.Class("task-property-chevron")], [outlineIcon(h, chevron)]),
        ],
      ),
      placement: "bottom-start",
      portal: true,
      panelClassName: "task-property-panel",
      focusSelector: `#${id}-panel ${field === "dueOn" ? '[role="listbox"]' : 'input[role="combobox"]'}`,
      content,
      toParentMessage: (message) =>
        Message.GotPropertyPopover({ target, message }),
    },
    h,
  );
};
