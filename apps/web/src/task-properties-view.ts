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
import { createTagPrefix } from "./tag-picker.ts";
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
  tagChoices,
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

export const tagIconPaths = ["M20 13.5 13.5 20 4 10.5V4h6.5zM8 8h.01"];
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

const tagLabel = (
  names: readonly string[],
  surface: PickerTarget["surface"],
  h: HtmlBuilder<Message>,
) => {
  if (!names.length) return "Add tags";
  if (names.length === 1) return names[0]!;
  if (surface !== "row") {
    const summary = `${names.length} tags`;
    return names.length === 2 && names.every((name) => name.length <= 10)
      ? h.span(
          [h.Class("task-detail-tag-pair")],
          [h.span([], [names.join(", ")]), h.span([], [summary])],
        )
      : summary;
  }
  return h.span(
    [h.Class("task-tag-names")],
    [
      h.span([h.Class("task-tag-name")], [names[0]!]),
      h.span([], [`+${names.length - 1}`]),
    ],
  );
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
  let error: string | null = null;
  const placeholder = {
    tagIds: "Search tags",
    status: "Search statuses",
    priority: "Search priorities",
    assignee: "Search assignees",
    dueOn: "",
  }[field];
  if (field === "tagIds") {
    const names = tags
      .filter(({ id }) => task.tagIds.includes(id))
      .map(({ name }) => name);
    displayed = names.length ? names.join(", ") : "Add tags";
    trigger = valueContent(
      field,
      names.length ? "set" : "",
      outlineIcon(h, tagIconPaths),
      tagLabel(names, surface, h),
      h,
    );
    selectedValues = task.tagIds;
    if (picker && open) {
      const result = tagChoices(picker.search.inputValue, task.tagIds, tags);
      options.push(
        ...result.choices.map((choice) => ({
          ...choice,
          disabled:
            choice.disabled ||
            (choice.id.startsWith(createTagPrefix) && model.request !== null),
        })),
      );
      if (task.tagIds.length)
        options.push({ id: clearChoice, name: "Clear all tags" });
      error = model.tagPickerError ?? result.error;
    }
  } else if (field === "dueOn") {
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
                  single: field !== "tagIds",
                  searchable: field !== "dueOn",
                  label: field === "dueOn" ? label : placeholder,
                  placeholder,
                  emptyMessage:
                    field === "tagIds"
                      ? "No matching tags."
                      : "No matching options.",
                  toParentMessage: (message) =>
                    Message.GotPropertySearch({ target, message }),
                },
                h,
              ),
              ...(error
                ? [
                    h.p(
                      [h.Role("status"), h.Class("task-picker-feedback")],
                      [error],
                    ),
                  ]
                : []),
            ],
          );
  return Popover.view(
    {
      model: picker?.popover ?? Popover.init({ id }),
      label,
      triggerLabel: `${label}: ${displayed}`,
      disabled:
        surface === "creation" &&
        (creationFieldsLocked(model) || (field === "tagIds" && !model.index)),
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
