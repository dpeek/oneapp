import {
  backIcon,
  badge,
  button,
  buttonClassName,
  dialog,
  field,
  input,
  MultiCombobox,
  navigationLinks,
  nativeSelect,
  outlineIcon,
  Popover,
  Sheet,
  textarea,
  Tokenizer,
} from "@oneapp/ui";
import { Effect, Option, Queue, Schema, Stream } from "effect";
import { Mount, Submodel } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
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
  FilterCategory,
  filterOptionsId,
  hasEdits,
  Message,
  selectedTask,
  tagSearch,
  toFilterPopoverMessage,
  toFilterTagsMessage,
  toFolderSheetMessage,
  writingCreation,
  type Editor,
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
const filterLabels = { status: "Status", priority: "Priority", tags: "Tags" };
const viewLabels = { active: "Active", completed: "Completed" };
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

const taskRow = (
  task: Task,
  tags: ReadonlyMap<string, Tag>,
  model: Model,
  h: HtmlBuilder<Message>,
) => {
  const completed = task.status === "completed";
  return h.li(
    [h.Key(task.id), h.Class("task-row")],
    [
      button(
        {
          ariaLabel: completed
            ? `Reopen ${task.title}`
            : `Complete ${task.title}`,
          variant: "ghost",
          size: "icon-sm",
          rounded: true,
          disabled: model.request !== null,
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
          h.Href(taskPath(task.id, model.view)),
          h.DataAttribute("task-id", task.id),
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

const filterCheckbox = (
  label: string,
  checked: boolean,
  message: Message,
  h: HtmlBuilder<Message>,
) =>
  h.label(
    [h.Key(label), h.Class("task-filter-choice")],
    [
      h.input([
        h.Type("checkbox"),
        h.Checked(checked),
        h.OnChange(() => message),
      ]),
      label,
    ],
  );

const WatchFilterMenu = Mount.defineStream("WatchTaskFilterMenu", {
  messages: [Message.OpenedFilterCategory, Message.ClosedFilterCategory],
  execute: ({ element }) =>
    Stream.callback<
      | typeof Message.OpenedFilterCategory.Type
      | typeof Message.ClosedFilterCategory.Type
    >((queue) => {
      const submenuSelector = `#${filterOptionsId}`;
      const close = Message.ClosedFilterCategory();
      const hover = (event: Event) => {
        if (
          !(event instanceof PointerEvent) ||
          event.pointerType === "touch" ||
          !(event.target instanceof Element)
        )
          return;
        const item = event.target.closest<HTMLButtonElement>(
          "[data-filter-category], .task-filter-clear",
        );
        if (
          !item ||
          item.getAttribute("aria-expanded") === "true" ||
          (event.relatedTarget instanceof Node &&
            item.contains(event.relatedTarget))
        )
          return;
        const category = item.getAttribute("data-filter-category");
        if (document.activeElement?.closest(submenuSelector))
          item.focus({ preventScroll: true });
        Queue.offerUnsafe(
          queue,
          Schema.is(FilterCategory)(category)
            ? Message.OpenedFilterCategory({ category, focusOptions: false })
            : close,
        );
      };
      const dismiss = (event: Event) => {
        if (
          !(event instanceof KeyboardEvent) ||
          event.key !== "Escape" ||
          event.isComposing ||
          !(event.target instanceof Element)
        )
          return;
        const submenu = event.target.closest(submenuSelector);
        if (!submenu) return;
        event.preventDefault();
        event.stopPropagation();
        const parent = submenu.previousElementSibling;
        if (parent instanceof HTMLElement)
          parent.focus({ preventScroll: true });
        Queue.offerUnsafe(queue, close);
      };
      return Effect.acquireRelease(
        Effect.sync(() => {
          element.addEventListener("pointerover", hover);
          element.addEventListener("keydown", dismiss);
        }),
        () =>
          Effect.sync(() => {
            element.removeEventListener("pointerover", hover);
            element.removeEventListener("keydown", dismiss);
          }),
      );
    }),
});

const taskFilterOptions = (
  model: Model,
  tags: readonly Tag[],
  h: HtmlBuilder<Message>,
) => {
  const { filterCategory, filters, filterTags } = model;
  if (!filterCategory) return h.empty;
  const tagQuery = tagNameKey(filterTags.inputValue);
  const options = {
    status: () =>
      [null, ...activeTaskStatuses].map((value) =>
        filterCheckbox(
          statusLabels[value ?? ""],
          filters.statuses.includes(value),
          Message.ToggledStatusFilter({ value }),
          h,
        ),
      ),
    priority: () =>
      [null, ...taskPriorities].map((value) =>
        filterCheckbox(
          priorityLabels[value ?? ""],
          filters.priorities.includes(value),
          Message.ToggledPriorityFilter({ value }),
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
  return h.div(
    [
      h.Key(filterCategory),
      h.Id(filterOptionsId),
      h.Class("task-filter-options"),
      h.Role("group"),
      h.AriaLabel(`${filterLabels[filterCategory]} filters`),
    ],
    options[filterCategory](),
  );
};

const taskFilters = (
  model: Model,
  tags: readonly Tag[],
  h: HtmlBuilder<Message>,
) => {
  const count = taskFilterCount(model);
  const categories =
    model.view === "active"
      ? (["status", "priority", "tags"] as const)
      : (["priority", "tags"] as const);
  return Popover.view(
    {
      model: model.filterPopover,
      label: "Filters",
      triggerLabel: count ? `Filters, ${count} selected` : "Filters",
      triggerButton: { variant: "outline", size: "sm" },
      trigger: h.span(
        [h.Class("task-filter-trigger")],
        [
          outlineIcon(h, ["M4 7h16M7 12h10m-7 5h4"]),
          "Filters",
          ...(count ? [badge(String(count), h)] : []),
        ],
      ),
      placement: "bottom-start",
      portal: false,
      panelClassName: "task-filter-popover",
      content: h.div(
        [h.Class("task-filter-categories"), h.OnMount(WatchFilterMenu())],
        [
          ...categories.map((category) => {
            const expanded = model.filterCategory === category;
            const enter = Message.OpenedFilterCategory({
              category,
              focusOptions: true,
            });
            return h.div(
              [h.Key(category), h.Class("task-filter-item")],
              [
                h.button(
                  [
                    h.Type("button"),
                    h.Class("task-filter-category"),
                    h.DataAttribute("slot", "task-filter-category"),
                    h.DataAttribute("filter-category", category),
                    h.AriaExpanded(expanded),
                    ...(expanded ? [h.AriaControls(filterOptionsId)] : []),
                    h.OnClick(enter),
                    h.OnKeyDownPreventDefault((key) =>
                      key === "ArrowRight" ? Option.some(enter) : Option.none(),
                    ),
                  ],
                  [filterLabels[category], outlineIcon(h, ["m9 18 6-6-6-6"])],
                ),
                ...(expanded ? [taskFilterOptions(model, tags, h)] : []),
              ],
            );
          }),
          h.button(
            [
              h.Type("button"),
              h.Class("task-filter-clear"),
              h.DataAttribute("slot", "task-filter-clear"),
              h.OnClick(Message.ClearedFilters()),
            ],
            ["Clear filters"],
          ),
        ],
      ),
      toParentMessage: toFilterPopoverMessage,
    },
    h,
  );
};

const taskList = (
  model: Model,
  tags: ReadonlyArray<Tag>,
  h: HtmlBuilder<Message>,
) => {
  const { view } = model;
  const viewTasks = (model.index?.tasks ?? []).filter(({ status }) =>
    view === "completed"
      ? status === "completed"
      : status !== "completed" && status !== "canceled",
  );
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
        [h.Class("task-list-toolbar task-list-filters")],
        [
          taskFilters(model, tags, h),
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
      h.div(
        [h.Key(view), h.Class("workspace-results")],
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
  creating: boolean,
  h: HtmlBuilder<Message>,
  tagsUnavailable = false,
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
          h.Required(creating),
          h.Autofocus(creating),
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
        ...(creating ? { placement: "top-start" } : {}),
        emptyMessage: "No matching tags",
        items: search.items,
        selected: tags.filter(({ id }) => draft.tagIds.includes(id)),
        maxLength: tagNameLimit,
        busy: busy || tagsUnavailable,
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

const OpenCreateDialog = Mount.define("OpenTaskCreateDialog", {
  messages: [Message.CreateDialogMounted],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (element instanceof HTMLDialogElement && !element.open)
          element.showModal();
      }),
      () =>
        Effect.sync(() => {
          if (element instanceof HTMLDialogElement && element.open)
            element.close();
        }),
    ).pipe(Effect.as(Message.CreateDialogMounted())),
});

const createDialogId = "task-create-dialog";
const sortedTags = (model: Model) =>
  [...(model.index?.tags ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

export const createView = Submodel.defineView<Model, Message>((model, h) => {
  const editor = model.creation;
  if (!editor) return h.empty;
  const busy =
    model.request !== null && model.request.operation._tag !== "Load";
  return dialog(
    {
      title: "Add task",
      titleId: "task-create-title",
      attributes: [
        h.Key(createDialogId),
        h.Id(createDialogId),
        h.OnMount(OpenCreateDialog()),
        h.OnCancel(Message.ClosedCreate()),
      ],
      children: [
        h.form(
          [
            h.Class("task-editor task-create-form"),
            h.OnSubmit(Message.Created()),
          ],
          [
            ...(editor.error ? [h.p([h.Role("alert")], [editor.error])] : []),
            ...(!model.index
              ? model.error
                ? [h.p([h.Role("alert")], [model.error])]
                : [h.p([h.Role("status")], ["Loading tasks and tags…"])]
              : []),
            ...taskFields(
              editor,
              sortedTags(model),
              busy,
              true,
              h,
              !model.index,
            ),
            h.div(
              [h.Class("task-actions")],
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
                ...(!model.index && !model.request
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
                button(
                  {
                    type: "submit",
                    size: "sm",
                    disabled:
                      model.request !== null ||
                      !model.index ||
                      !editor.draft.title.trim(),
                    children: [
                      model.request?.operation._tag === "Create"
                        ? "Adding…"
                        : "Add task",
                    ],
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
});

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
  const time = (value: number) =>
    h.time(
      [h.Datetime(new Date(value).toISOString())],
      [timestamp.format(value)],
    );
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
                ...taskFields(editor, tags, busy, false, h),
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
  return workspace(
    {
      className: "workspace-stacked tasks-workspace",
      title: selectedId ? undefined : viewLabels[model.view],
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
            dialogId: createDialogId,
            onClick: Message.OpenedCreate({ preserveView: false }),
            children: ["Add task"],
          },
          h,
        ),
        ...(model.error
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
          : []),
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
