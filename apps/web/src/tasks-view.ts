import {
  backIcon,
  button,
  field,
  input,
  nativeSelect,
  outlineIcon,
  textarea,
  Tokenizer,
} from "@oneapp/ui";
import { Submodel } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { tagNameLimit, type Tag } from "./items-contract.ts";
import {
  type Task,
  taskDescriptionLimit,
  taskPath,
  tasksPath,
  taskTagLimit,
  taskTitleLimit,
} from "./tasks-contract.ts";
import {
  hasEdits,
  Message,
  selectedTask,
  tagSearch,
  type Model,
} from "./tasks.ts";
import { workspace } from "./workspace.ts";

const statusLabels = {
  "": "No status",
  "not-started": "Not Started",
  "in-progress": "In Progress",
  "in-review": "In Review",
  completed: "Completed",
  canceled: "Canceled",
} satisfies Record<NonNullable<Task["status"]> | "", string>;
const priorityLabels = {
  "": "No priority",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
} satisfies Record<NonNullable<Task["priority"]> | "", string>;
const priorityRank = { "": 0, low: 1, medium: 2, high: 3, urgent: 4 };
const statusOptions = Object.entries(statusLabels).map(([value, label]) => ({
  value,
  label,
}));
const priorityOptions = Object.entries(priorityLabels).map(
  ([value, label]) => ({ value, label }),
);
const dueDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const timestamp = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const activeStatus = (status: Task["status"]) =>
  status !== "completed" && status !== "canceled";

const sortedTasks = (model: Model) =>
  (model.index?.tasks ?? [])
    .filter(
      (task) =>
        (model.statusFilter === "all" ||
          (model.statusFilter === "active"
            ? activeStatus(task.status)
            : task.status === model.statusFilter)) &&
        (model.tagFilter === null || task.tagIds.includes(model.tagFilter)),
    )
    .sort((left, right) => {
      if (model.sort === "priority") {
        const order =
          priorityRank[right.priority ?? ""] -
          priorityRank[left.priority ?? ""];
        if (order) return order;
      }
      if (model.sort === "due") {
        const order = (left.dueOn ?? "9999-99-99").localeCompare(
          right.dueOn ?? "9999-99-99",
        );
        if (order) return order;
      }
      return (
        right.updatedAt - left.updatedAt || right.id.localeCompare(left.id)
      );
    });

const taskRow = (
  task: Task,
  tags: ReadonlyMap<string, Tag>,
  model: Model,
  h: HtmlBuilder<Message>,
) => {
  const completed = task.status === "completed";
  const selected = model.selectedId === task.id;
  const draft = selected ? model.draft : null;
  return h.li(
    [
      h.Key(task.id),
      h.Class("task-row"),
      h.DataAttribute("selected", String(selected)),
    ],
    [
      button(
        {
          ariaLabel: completed
            ? `Reopen ${task.title}`
            : `Complete ${task.title}`,
          variant: "ghost",
          size: "icon-sm",
          rounded: true,
          disabled:
            model.request !== null || (draft !== null && hasEdits(draft, task)),
          attributes: [h.DataAttribute("task-complete", String(completed))],
          onClick: Message.ToggledCompletion({ id: task.id }),
          children: [
            outlineIcon(
              h,
              completed
                ? ["m5 12 4 4L19 6"]
                : ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z"],
            ),
          ],
        },
        h,
      ),
      h.a(
        [
          h.Class("task-row-link"),
          h.Href(taskPath(task.id)),
          ...(selected ? [h.AriaCurrent("page")] : []),
        ],
        [
          h.span(
            [h.Class("task-row-main")],
            [
              h.span([h.Class("task-row-title")], [task.title]),
              ...task.tagIds.flatMap((id) => {
                const tag = tags.get(id);
                return tag
                  ? [h.span([h.Key(id), h.Class("task-tag")], [tag.name])]
                  : [];
              }),
            ],
          ),
          h.span(
            [h.Class("task-row-properties")],
            [
              h.span(
                [
                  h.Class("task-status"),
                  h.DataAttribute("status", task.status ?? ""),
                ],
                [statusLabels[task.status ?? ""]],
              ),
              ...(task.priority
                ? [
                    h.span(
                      [
                        h.Class("task-priority"),
                        h.DataAttribute("priority", task.priority),
                      ],
                      [priorityLabels[task.priority]],
                    ),
                  ]
                : []),
              ...(task.dueOn
                ? [
                    h.time(
                      [h.Datetime(task.dueOn), h.Class("task-due")],
                      [`Due ${dueDate.format(new Date(task.dueOn))}`],
                    ),
                  ]
                : []),
            ],
          ),
        ],
      ),
    ],
  );
};

const taskList = (
  model: Model,
  tags: ReadonlyArray<Tag>,
  h: HtmlBuilder<Message>,
) => {
  const tasks = sortedTasks(model);
  const busy = model.request !== null;
  const creatingDisabled = busy || !model.index;
  const tagMap = new Map(tags.map((tag) => [tag.id, tag]));
  return h.section(
    [h.Class("workspace-list task-list"), h.AriaLabel("Task list")],
    [
      h.div(
        [h.Class("task-list-toolbar")],
        [
          h.form(
            [h.Class("task-inline-form"), h.OnSubmit(Message.Created())],
            [
              input(
                [
                  h.AriaLabel("New task title"),
                  h.Type("text"),
                  h.Maxlength(taskTitleLimit),
                  h.Placeholder("New task title"),
                  h.Value(model.quickTitle),
                  h.Required(true),
                  h.Disabled(creatingDisabled),
                  h.OnInput((title) => Message.EditedQuickTitle({ title })),
                ],
                h,
              ),
              button(
                {
                  type: "submit",
                  size: "sm",
                  disabled: creatingDisabled,
                  children: ["Add task"],
                },
                h,
              ),
            ],
          ),
          h.div(
            [h.Class("task-list-filters")],
            [
              nativeSelect(
                {
                  label: "Status filter",
                  value: model.statusFilter ?? "",
                  options: [
                    { value: "active", label: "Active" },
                    { value: "all", label: "All statuses" },
                    ...statusOptions,
                  ],
                  onChange: (value) => Message.SetStatusFilter({ value }),
                },
                h,
              ),
              nativeSelect(
                {
                  label: "Tag filter",
                  value: model.tagFilter ?? "",
                  options: [
                    { value: "", label: "All tags" },
                    ...tags.map((tag) => ({ value: tag.id, label: tag.name })),
                  ],
                  onChange: (value) => Message.SetTagFilter({ value }),
                },
                h,
              ),
              nativeSelect(
                {
                  label: "Sort by",
                  value: model.sort,
                  options: [
                    { value: "updated", label: "Updated" },
                    { value: "priority", label: "Priority" },
                    { value: "due", label: "Due date" },
                  ],
                  onChange: (value) => Message.SetSort({ value }),
                },
                h,
              ),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("workspace-results")],
        [
          !model.index
            ? busy
              ? h.p(
                  [h.Class("task-empty"), h.Role("status")],
                  ["Loading tasks…"],
                )
              : h.empty
            : tasks.length
              ? h.ul(
                  [h.Class("task-rows")],
                  tasks.map((task) => taskRow(task, tagMap, model, h)),
                )
              : h.p(
                  [h.Class("task-empty"), h.Role("status")],
                  [
                    model.index.tasks.length
                      ? "No tasks match these filters."
                      : "Add your first task above.",
                  ],
                ),
        ],
      ),
    ],
  );
};

const taskDetail = (
  model: Model,
  tags: ReadonlyArray<Tag>,
  h: HtmlBuilder<Message>,
) => {
  const task = selectedTask(model);
  const draft = model.draft;
  const busy = model.request !== null;
  const tagsFull = (draft?.tagIds.length ?? 0) >= taskTagLimit;
  const search = draft && tagSearch(model, tags);
  const changed = !!(task && draft && hasEdits(draft, task));
  const stale = !!(task && draft && task.revision !== draft.revision);
  const time = (value: number) =>
    h.time(
      [h.Datetime(new Date(value).toISOString())],
      [timestamp.format(value)],
    );
  const back = h.a(
    [h.Class("task-back"), h.Href(tasksPath)],
    [backIcon(h), "All tasks"],
  );
  return h.section(
    [h.Class("workspace-detail task-detail"), h.AriaLabel("Task details")],
    [
      back,
      ...(!task || !draft
        ? [
            h.p(
              [h.Role("status")],
              [
                !model.index
                  ? busy
                    ? "Loading task…"
                    : "Task details are unavailable."
                  : "Task not found.",
              ],
            ),
          ]
        : [
            h.div(
              [h.Key(task.id), h.Class("task-editor")],
              [
                field(
                  "Title",
                  input(
                    [
                      h.Type("text"),
                      h.Value(draft.title),
                      h.Maxlength(taskTitleLimit),
                      h.Disabled(busy),
                      h.OnInput((value) =>
                        Message.EditedField({ field: "title", value }),
                      ),
                    ],
                    h,
                  ),
                  h,
                ),
                h.div(
                  [h.Class("task-fields")],
                  [
                    nativeSelect(
                      {
                        label: "Status",
                        options: statusOptions,
                        value: draft.status ?? "",
                        disabled: busy,
                        onChange: (value) =>
                          Message.EditedField({ field: "status", value }),
                      },
                      h,
                    ),
                    nativeSelect(
                      {
                        label: "Priority",
                        options: priorityOptions,
                        value: draft.priority ?? "",
                        disabled: busy,
                        onChange: (value) =>
                          Message.EditedField({ field: "priority", value }),
                      },
                      h,
                    ),
                    field(
                      "Due date",
                      input(
                        [
                          h.Type("date"),
                          h.Value(draft.dueOn ?? ""),
                          h.Disabled(busy),
                          h.OnInput((value) =>
                            Message.EditedField({ field: "dueOn", value }),
                          ),
                        ],
                        h,
                      ),
                      h,
                    ),
                  ],
                ),
                field(
                  "Description (Markdown)",
                  textarea(
                    [
                      h.Value(draft.description),
                      h.Maxlength(taskDescriptionLimit),
                      h.Disabled(busy),
                      h.OnInput((value) =>
                        Message.EditedField({ field: "description", value }),
                      ),
                    ],
                    h,
                  ),
                  h,
                ),
                Tokenizer.view(
                  {
                    model: model.tagPicker,
                    label: "Tags",
                    placeholder: "Search or create tags",
                    emptyMessage: "No matching tags",
                    items: search?.items ?? [],
                    selected: tags.filter(({ id }) =>
                      draft.tagIds.includes(id),
                    ),
                    maxLength: tagNameLimit,
                    busy,
                    full: tagsFull,
                    description: tagsFull
                      ? `A task can have up to ${taskTagLimit} tags.`
                      : null,
                    error: search?.error ?? null,
                    toParentMessage: (message) =>
                      Message.GotTagPickerMessage({ message }),
                    onRemove: (id) => Message.RemovedTag({ id }),
                  },
                  h,
                ),
                h.div(
                  [h.Class("task-actions")],
                  [
                    button(
                      {
                        size: "sm",
                        disabled:
                          busy || stale || !changed || !draft.title.trim(),
                        onClick: Message.Saved(),
                        children: ["Save changes"],
                      },
                      h,
                    ),
                    ...(changed || stale
                      ? [
                          button(
                            {
                              variant: "outline",
                              size: "sm",
                              disabled: busy,
                              onClick: Message.Discarded(),
                              children: [
                                stale ? "Reload saved task" : "Discard changes",
                              ],
                            },
                            h,
                          ),
                        ]
                      : []),
                  ],
                ),
                h.dl(
                  [h.Class("task-timestamps")],
                  [
                    h.div(
                      [],
                      [h.dt([], ["Created"]), h.dd([], [time(task.createdAt)])],
                    ),
                    h.div(
                      [],
                      [h.dt([], ["Updated"]), h.dd([], [time(task.updatedAt)])],
                    ),
                  ],
                ),
              ],
            ),
          ]),
    ],
  );
};

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const tags = [...(model.index?.tags ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  return workspace(
    {
      className: "tasks-workspace",
      title: "Tasks",
      headerActions: model.error
        ? [
            h.div(
              [h.Class("task-error")],
              [
                h.p([h.Role("alert")], [model.error]),
                ...(!model.index
                  ? [
                      button(
                        {
                          variant: "outline",
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
        : [],
      list: taskList(model, tags, h),
      hasSelection: model.selectedId !== null,
      ...(model.selectedId ? { detail: taskDetail(model, tags, h) } : {}),
    },
    h,
  );
});
