import {
  alert,
  backIcon,
  button,
  buttonClassName,
  Dialog,
  field,
  input,
  MultiCombobox,
  navigationLinks,
  nativeSelect,
  outlineIcon,
  Sheet,
  textarea,
  Tokenizer,
} from "@oneapp/ui";
import { Effect, Option } from "effect";
import { Mount, Submodel } from "foldkit";
import type { ChildAttribute, HtmlBuilder } from "foldkit/html";
import { tagNameKey, tagNameLimit, type Tag } from "./items-contract.ts";
import {
  activeTaskStatuses,
  type Task,
  taskDescriptionLimit,
  taskListPath,
  taskPath,
  taskPriorities,
  taskTagLimit,
  taskTitleLimit,
  type TaskView,
} from "./tasks-contract.ts";
import { matchesTaskFilters, taskFilterCount } from "./tasks-filters.ts";
import {
  type FilterCategory,
  creationDialogId,
  creationSubmitId,
  creationTitleId,
  filterOptionsId,
  hasEdits,
  Message,
  selectedTask,
  tagSearch,
  taskSortMenu,
  tasksInView,
  toFilterPopoverMessage,
  toFilterTagsMessage,
  toFolderSheetMessage,
  toSortMenuMessage,
  writingCreation,
  type Editor,
  type Model,
} from "./tasks.ts";
import { filterChoice, filterMenu } from "./filter-menu.ts";
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
const filterLabels = { status: "Status", priority: "Priority", tags: "Tags" };
const viewLabels = { active: "Active", completed: "Completed" };
const priorityOptions = Object.entries(priorityLabels).map(
  ([value, label]) => ({ value, label }),
);
const timestamp = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const sortedTasks = (tasks: readonly Task[], model: Model) =>
  tasks
    .filter((task) => matchesTaskFilters(task, model))
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

const taskTimestamp = (value: number, h: HtmlBuilder<Message>) =>
  h.time(
    [h.Datetime(new Date(value).toISOString())],
    [timestamp.format(value)],
  );

const taskRow = (
  task: Task,
  tags: ReadonlyMap<string, Tag>,
  view: TaskView,
  h: HtmlBuilder<Message>,
) =>
  h.tr(
    [h.Key(task.id), h.Class("task-row")],
    [
      h.td(
        [],
        [
          h.div(
            [h.Class("task-row-main")],
            [
              h.a(
                [
                  h.Class("task-row-link"),
                  h.Href(taskPath(task.id, view)),
                  h.DataAttribute("task-id", task.id),
                ],
                [task.title],
              ),
              ...task.tagIds.flatMap((id) => {
                const tag = tags.get(id);
                return tag
                  ? [h.span([h.Key(id), h.Class("task-tag")], [tag.name])]
                  : [];
              }),
            ],
          ),
        ],
      ),
      h.td(
        [],
        [
          h.span(
            [
              h.Class("task-status"),
              h.DataAttribute("status", task.status ?? ""),
            ],
            [statusLabels[task.status ?? ""]],
          ),
        ],
      ),
      h.td(
        [
          h.Class("task-priority"),
          h.DataAttribute("priority", task.priority ?? ""),
        ],
        [priorityLabels[task.priority ?? ""]],
      ),
      h.td([h.Class("task-updated")], [taskTimestamp(task.updatedAt, h)]),
    ],
  );

const taskFilterOptions = (
  filterCategory: typeof FilterCategory.Type,
  { filters, filterTags }: Model,
  tags: readonly Tag[],
  h: HtmlBuilder<Message>,
) => {
  const tagQuery = tagNameKey(filterTags.inputValue);
  const options = {
    status: () =>
      [null, ...activeTaskStatuses].map((value) =>
        filterChoice(
          {
            label: statusLabels[value ?? ""],
            checked: filters.statuses.includes(value),
            message: Message.ToggledStatusFilter({ value }),
          },
          h,
        ),
      ),
    priority: () =>
      [null, ...taskPriorities].map((value) =>
        filterChoice(
          {
            label: priorityLabels[value ?? ""],
            checked: filters.priorities.includes(value),
            message: Message.ToggledPriorityFilter({ value }),
          },
          h,
        ),
      ),
    tags: () => [
      MultiCombobox.view(
        {
          model: filterTags,
          label: "Search tags",
          placeholder: "Search tags…",
          emptyMessage: tagQuery ? "No matching tags." : "No tags yet.",
          items: tags.filter(({ name }) => tagNameKey(name).includes(tagQuery)),
          selectedValues: filters.tagIds,
          toParentMessage: toFilterTagsMessage,
        },
        h,
      ),
    ],
  };
  return options[filterCategory]();
};

const taskFilters = (
  model: Model,
  tags: readonly Tag[],
  h: HtmlBuilder<Message>,
) => {
  const categories =
    model.view === "active"
      ? (["status", "priority", "tags"] as const)
      : (["priority", "tags"] as const);
  return filterMenu(
    {
      popover: model.filterPopover,
      category: model.filterCategory,
      categories: categories.map((id) => ({ id, label: filterLabels[id] })),
      count: taskFilterCount(model),
      optionsId: filterOptionsId,
      options: (category) => taskFilterOptions(category, model, tags, h),
      onOpen: (category, focusOptions) =>
        Message.OpenedFilterCategory({ category, focusOptions }),
      close: Message.ClosedFilterCategory(),
      clear: Message.ClearedFilters(),
      toPopoverMessage: toFilterPopoverMessage,
    },
    h,
  );
};

const taskSort = (model: Model, h: HtmlBuilder<Message>) =>
  taskSortMenu.view(
    {
      model: model.sortMenu,
      label: "Sort by",
      trigger: outlineIcon(h, ["M11 5h9m-9 7h7m-7 7h5M5 5v14m-3-3 3 3 3-3"]),
      selected: model.sort,
      options: [
        { value: "updated", label: "Updated" },
        { value: "priority", label: "Priority" },
        { value: "due", label: "Due date" },
      ],
      toParentMessage: toSortMenuMessage,
    },
    h,
  );

const taskList = (
  model: Model,
  tags: ReadonlyArray<Tag>,
  h: HtmlBuilder<Message>,
) => {
  const { view } = model;
  const viewTasks = tasksInView(model);
  const tasks = sortedTasks(viewTasks, model);
  const busy = model.request !== null;
  const tagMap = new Map(tags.map((tag) => [tag.id, tag]));
  return h.section(
    [
      h.Class("workspace-list task-list"),
      h.AriaLabel("Task list"),
      h.Inert(model.selectedId !== null),
      h.Tabindex(-1),
    ],
    [
      h.div(
        [
          h.Key(view),
          h.Class("workspace-results task-table-scroll"),
          ...(tasks.length
            ? [
                h.Role("group"),
                h.AriaLabel("Scrollable task table"),
                h.Tabindex(0),
              ]
            : []),
        ],
        [
          !model.index
            ? busy
              ? h.p(
                  [h.Class("task-empty"), h.Role("status")],
                  ["Loading tasks…"],
                )
              : h.empty
            : tasks.length
              ? h.table(
                  [
                    h.Class("task-table"),
                    h.AriaLabel(`${viewLabels[view]} tasks`),
                  ],
                  [
                    h.thead(
                      [],
                      [
                        h.tr(
                          [],
                          [
                            h.th([h.Scope("col")], ["Task"]),
                            h.th([h.Scope("col")], ["Status"]),
                            h.th([h.Scope("col")], ["Priority"]),
                            h.th([h.Scope("col")], ["Updated"]),
                          ],
                        ),
                      ],
                    ),
                    h.tbody(
                      [],
                      tasks.map((task) => taskRow(task, tagMap, view, h)),
                    ),
                  ],
                )
              : h.p(
                  [h.Class("task-empty"), h.Role("status")],
                  [
                    viewTasks.length
                      ? "No tasks match these filters."
                      : `No ${view} tasks yet.`,
                  ],
                ),
        ],
      ),
    ],
  );
};

const taskFields = (
  editor: Editor,
  tags: ReadonlyArray<Tag>,
  busy: boolean,
  h: HtmlBuilder<Message>,
  creation?: {
    initialFocus: ReadonlyArray<ChildAttribute>;
    tagsUnavailable: boolean;
  },
) => {
  const { draft } = editor;
  const tagsFull = draft.tagIds.length >= taskTagLimit;
  const search = tagSearch(editor, tags);
  return [
    field(
      "Title",
      input<Message>(
        [
          h.Type("text"),
          h.Value(draft.title),
          h.Maxlength(taskTitleLimit),
          ...(creation
            ? [
                h.Id(creationTitleId),
                h.Required(true),
                ...creation.initialFocus,
              ]
            : []),
          h.Disabled(busy),
          h.OnInput((value) => Message.EditedField({ field: "title", value })),
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
          input<Message>(
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
      textarea<Message>(
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
        model: editor.tagPicker,
        label: "Tags",
        placeholder: "Search or create tags",
        ...(creation ? { placement: "top-start" } : {}),
        emptyMessage: "No matching tags",
        items: search.items,
        selected: tags.filter(({ id }) => draft.tagIds.includes(id)),
        maxLength: tagNameLimit,
        busy: busy || creation?.tagsUnavailable === true,
        full: tagsFull,
        description: tagsFull
          ? `A task can have up to ${taskTagLimit} tags.`
          : null,
        error: search.error,
        toParentMessage: (message) =>
          Message.GotTagPickerMessage({ id: draft.id, message }),
        onRemove: (id) => Message.RemovedTag({ id }),
      },
      h,
    ),
  ];
};

const sortedTags = (model: Model) =>
  [...(model.index?.tags ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

const retryTasksButton = (h: HtmlBuilder<Message>) =>
  button(
    {
      variant: "outline",
      size: "sm",
      onClick: Message.Retried(),
      children: ["Retry"],
    },
    h,
  );

export const createView = Submodel.defineView(
  (
    model: Model,
    initialFocus: ReadonlyArray<ChildAttribute>,
    h: HtmlBuilder<Message>,
  ) => {
    const editor = model.creation;
    if (!editor) return h.empty;
    const busy =
      model.request !== null && model.request.operation._tag !== "Load";
    const submitting = model.request?.operation._tag === "Create";
    const loadError = model.index ? null : (model.error?.message ?? null);
    return h.form(
      [h.Class("task-editor task-create-form"), h.OnSubmit(Message.Created())],
      [
        alert(
          {
            message: editor.error ?? loadError,
            severity: "error",
            announcement: "status",
            action:
              loadError && !model.request ? retryTasksButton(h) : undefined,
          },
          h,
        ),
        ...(!model.index && !loadError
          ? [h.p([h.Role("status")], ["Loading tasks and tags…"])]
          : []),
        ...taskFields(editor, sortedTags(model), busy, h, {
          initialFocus,
          tagsUnavailable: !model.index,
        }),
        Dialog.footer(
          [
            button(
              {
                variant: "outline",
                size: "sm",
                disabled: writingCreation(model),
                onClick: Message.ClosedCreate(),
                children: ["Cancel"],
              },
              h,
            ),
            button(
              {
                type: "submit",
                size: "sm",
                attributes: [h.Id(creationSubmitId)],
                focusableWhenDisabled: submitting,
                disabled:
                  model.request !== null ||
                  !model.index ||
                  !editor.draft.title.trim(),
                children: [submitting ? "Adding…" : "Add task"],
              },
              h,
            ),
          ],
          h,
        ),
      ],
    );
  },
);

const FocusDetail = Mount.define("FocusTaskDetail", {
  messages: [Message.FocusUpdated],
  execute: ({ element }) =>
    Effect.sync(() => {
      if (element instanceof HTMLElement)
        element.focus({ preventScroll: true });
      return Message.FocusUpdated();
    }),
});

const taskDetail = (
  id: string,
  model: Model,
  tags: ReadonlyArray<Tag>,
  h: HtmlBuilder<Message>,
) => {
  const task = selectedTask(model);
  const editor = model.editor;
  const busy = model.request !== null;
  const changed = !!(task && editor && hasEdits(editor.draft, task));
  const stale = !!(task && editor && task.revision !== editor.draft.revision);
  return h.section(
    [
      h.Key(id),
      h.Class("workspace-detail task-detail"),
      h.AriaLabel("Task details"),
      h.Tabindex(-1),
      h.OnMount(FocusDetail()),
    ],
    [
      ...(!task || !editor
        ? [
            h.p(model.error ? [] : [h.Role("status")], [
              !model.index
                ? busy
                  ? "Loading task…"
                  : "Task details are unavailable."
                : "Task not found.",
            ]),
          ]
        : [
            h.div(
              [h.Key(task.id), h.Class("task-editor")],
              [
                ...taskFields(editor, tags, busy, h),
                h.div(
                  [h.Class("task-actions")],
                  [
                    button(
                      {
                        size: "sm",
                        disabled:
                          busy ||
                          stale ||
                          !changed ||
                          !editor.draft.title.trim(),
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
                      [
                        h.dt([], ["Created"]),
                        h.dd([], [taskTimestamp(task.createdAt, h)]),
                      ],
                    ),
                    h.div(
                      [],
                      [
                        h.dt([], ["Updated"]),
                        h.dd([], [taskTimestamp(task.updatedAt, h)]),
                      ],
                    ),
                  ],
                ),
              ],
            ),
          ]),
    ],
  );
};

const taskNavigation = (view: TaskView, h: HtmlBuilder<Message>) =>
  navigationLinks(
    {
      label: "Task views",
      variant: "sidebar",
      destinations: (["active", "completed"] as const).map((destination) => ({
        href: taskListPath(destination),
        label: viewLabels[destination],
        current: destination === view,
      })),
    },
    h,
  );

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const tags = sortedTags(model);
  const { selectedId, folderSheet } = model;
  const backLabel = `Back to ${viewLabels[model.view]}`;
  // The load error stays visible after Add task closes, without announcing again.
  const loadErrorInDialog =
    (!model.index && model.creation) || model.error?.announcedInCreation;
  return workspace(
    {
      className: "workspace-stacked tasks-workspace",
      headerAttributes: [h.Tabindex(-1)],
      title: selectedId ? undefined : viewLabels[model.view],
      titleAccessory: selectedId
        ? undefined
        : h.div(
            [h.Class("task-header-menus")],
            [taskFilters(model, tags, h), taskSort(model, h)],
          ),
      headerActions: [
        ...(selectedId
          ? [
              h.a(
                [
                  h.Href(taskListPath(model.view)),
                  h.Class(
                    buttonClassName({
                      variant: "ghost",
                      size: "icon-sm",
                      rounded: true,
                    }),
                  ),
                  h.DataAttribute("slot", "button"),
                  h.AriaLabel(backLabel),
                  h.Title(backLabel),
                ],
                [backIcon(h)],
              ),
            ]
          : []),
        h.div(
          [h.Class("workspace-drawer-trigger")],
          [
            button(
              {
                variant: "ghost",
                size: "icon",
                rounded: true,
                ariaLabel: "Task views",
                dialogId: folderSheet.id,
                onClick: toFolderSheetMessage(Sheet.Message.RequestedOpen()),
                children: [outlineIcon(h, ["M4 6h16M4 12h16M4 18h16"])],
              },
              h,
            ),
          ],
        ),
        button(
          {
            size: "sm",
            disabled: model.request !== null || !model.index,
            dialogId: creationDialogId,
            onClick: Message.OpenedCreate({ preserveView: false }),
            children: ["Add task"],
          },
          h,
        ),
        alert(
          {
            message: model.error?.message ?? null,
            severity: "error",
            announcement: loadErrorInDialog ? "static" : "status",
            action:
              model.error && !model.index ? retryTasksButton(h) : undefined,
          },
          h,
        ),
      ],
      sidebar: taskNavigation(model.view, h),
      list: taskList(model, tags, h),
      hasSelection: selectedId !== null,
      ...(selectedId ? { detail: taskDetail(selectedId, model, tags, h) } : {}),
      sheet: Sheet.sheet(
        {
          model: folderSheet,
          title: "Task views",
          content: taskNavigation(model.view, h),
          toParentMessage: toFolderSheetMessage,
        },
        h,
      ),
    },
    h,
  );
});
