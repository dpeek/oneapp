import {
  alert,
  avatar,
  button,
  circleCheckIconPaths,
  circleDashedIconPaths,
  circleDotDashedIconPaths,
  circleXIconPaths,
  clockIconPaths,
  cloudIconPaths,
  Dialog,
  empty,
  field,
  flameIconPaths,
  input,
  MultiCombobox,
  navigationLinks,
  nativeSelect,
  outlineIcon,
  plusIcon,
  Sheet,
  signalHighIconPaths,
  signalLowIconPaths,
  signalMediumIconPaths,
  skeleton,
  spinnerIcon,
  taskIconPaths,
  textarea,
  timestamp,
  Tokenizer,
  userCheckIconPaths,
  visuallyHiddenStatus,
} from "@orumai/ui";
import { Effect, Option } from "effect";
import { Mount, Submodel } from "foldkit";
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html";
import * as Attachments from "./task-attachments.ts";
import { tagNameKey, tagNameLimit, type Tag } from "./items-contract.ts";
import { profileAvatar } from "./people.ts";
import type { PersonSummary } from "./people-contract.ts";
import { isTaskRunInterrupted, type TaskRun } from "./task-run-contract.ts";
import {
  type Task,
  taskDescriptionLimit,
  taskPath,
  tasksPath,
  taskPriorities,
  taskStatuses,
  taskTagLimit,
  taskTitleLimit,
} from "./tasks-contract.ts";
import { matchesTaskFilters, taskFilterCount } from "./tasks-filters.ts";
import {
  FilterCategory,
  creationDialogId,
  creationSubmitId,
  creationTitleId,
  deleteConflictMessage,
  deleteDialogId,
  filterOptionsId,
  hasEdits,
  Message,
  selectedTask,
  tagSearch,
  taskSortMenu,
  toFilterPopoverMessage,
  toFilterTagsMessage,
  toAttachmentsMessage,
  toDeleteDialogMessage,
  toFolderSheetMessage,
  toSortMenuMessage,
  writingCreation,
  type Editor,
  type Model,
} from "./tasks.ts";
import { filterChoice, filterMenu } from "./filter-menu.ts";
import { screenHeader, screenHeaderBack, workspace } from "./workspace.ts";

type TaskRowValue = { label: string; icon: readonly string[] };
type ViewInputs = { owner: PersonSummary | null; ownerEmail: string };

const taskStatusDisplay = {
  "not-started": { label: "Not started", icon: circleDotDashedIconPaths },
  "in-progress": { label: "In progress", icon: clockIconPaths },
  "in-review": { label: "In review", icon: userCheckIconPaths },
  completed: { label: "Complete", icon: circleCheckIconPaths },
  canceled: { label: "Cancelled", icon: circleXIconPaths },
} satisfies Record<Task["status"], TaskRowValue>;
const taskPriorityDisplay = {
  "": { label: "No priority", icon: circleDashedIconPaths },
  low: { label: "Low", icon: signalLowIconPaths },
  medium: { label: "Medium", icon: signalMediumIconPaths },
  high: { label: "High", icon: signalHighIconPaths },
  urgent: { label: "Urgent", icon: flameIconPaths },
} satisfies Record<NonNullable<Task["priority"]> | "", TaskRowValue>;
const runPhaseDisplay = {
  setup: {
    label: "Setting up",
    icon: ["M5 3v5m0 4v9M12 3v10m0 4v4m7-18v3m0 4v11M2 8h6m1 9h6m1-11h6"],
  },
  implementation: {
    label: "Agent working",
    icon: ["m8 6-6 6 6 6m8-12 6 6-6 6"],
  },
  checks: { label: "Running checks", icon: taskIconPaths },
  deployment: {
    label: "Waiting for deploy",
    icon: ["M12 16V4m-4 4 4-4 4 4M4 16v4h16v-4"],
  },
} satisfies Record<Exclude<TaskRun["phase"], "finished">, TaskRowValue>;
const runOutcomeLabels = {
  deployed: "Deployed",
  "setup-failed": "Setup failed",
  "implementation-failed": "Implementation failed",
  "checks-failed": "Checks failed",
  "deployment-failed": "Deployment failed",
  interrupted: "Run interrupted",
} satisfies Record<NonNullable<TaskRun["outcome"]> | "interrupted", string>;

const runActivity = (
  run: TaskRun,
  now: number,
  variant: "indicator" | "detail",
  h: HtmlBuilder<Message>,
) => {
  const outcome = isTaskRunInterrupted(run, now) ? "interrupted" : run.outcome;
  const { phase } = run;
  const display = outcome
    ? {
        label: runOutcomeLabels[outcome],
        icon: outcome === "deployed" ? cloudIconPaths : circleXIconPaths,
      }
    : phase === "finished"
      ? null
      : runPhaseDisplay[phase];
  if (!display) return h.empty;

  const { label, icon } = display;
  const activity = outcome
    ? h.DataAttribute("outcome", outcome)
    : h.DataAttribute("activity", phase);
  if (variant === "indicator")
    return h.span(
      [
        h.Class("task-row-value task-activity-indicator"),
        activity,
        h.Title(label),
        h.Role("img"),
        h.AriaLabel(label),
      ],
      outcome ? [outlineIcon(h, icon)] : [spinnerIcon(h), outlineIcon(h, icon)],
    );
  return h.span(
    [h.Class("task-row-value"), activity],
    [outcome ? outlineIcon(h, icon) : spinnerIcon(h, 16), h.span([], [label])],
  );
};

const latestRunDetails = (
  run: TaskRun,
  now: number,
  h: HtmlBuilder<Message>,
) => {
  const reason =
    run.reason ??
    (isTaskRunInterrupted(run, now)
      ? "The runner stopped reporting activity."
      : null);
  return h.section(
    [h.Class("task-latest-run"), h.AriaLabel("Latest run")],
    [
      h.h2([], ["Latest run"]),
      h.div([h.Role("status")], [runActivity(run, now, "detail", h)]),
      ...(run.summary ? [h.p([], [run.summary])] : []),
      ...(reason ? [h.p([], [reason])] : []),
      ...(run.deploymentUrl
        ? [
            h.a(
              [
                h.Href(run.deploymentUrl),
                h.Target("_blank"),
                h.Rel("noreferrer"),
              ],
              ["View deployment"],
            ),
          ]
        : []),
    ],
  );
};
const priorityRank = { "": 0, low: 1, medium: 2, high: 3, urgent: 4 };
const statusOptions = taskStatuses.map((value) => ({
  value,
  label: taskStatusDisplay[value].label,
}));
const filterLabels = { status: "Status", priority: "Priority", tags: "Tags" };
const taskListLabel = "All tasks";
const priorityOptions = Object.entries(taskPriorityDisplay).map(
  ([value, { label }]) => ({ value, label }),
);
const assigneeLabels = { owner: "Me", oru: "Oru", "": "Unassigned" };
const assigneeOptions = Object.entries(assigneeLabels).map(
  ([value, label]) => ({
    value,
    label,
  }),
);
const taskDateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const sortedTasks = (tasks: readonly Task[], model: Model) =>
  tasks
    .filter((task) => matchesTaskFilters(task, model.filters))
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
    [taskDateTimeFormat.format(value)],
  );

const taskRowValue = (
  label: string,
  media: Html,
  kind: "status" | "priority" | "assignee",
  value: string,
  h: HtmlBuilder<Message>,
) =>
  h.td(
    [],
    [
      h.span(
        [h.Class("task-row-value"), h.DataAttribute(kind, value)],
        [media, h.span([h.Class("task-row-value-label")], [label])],
      ),
    ],
  );

const taskRow = (
  task: Task,
  tags: ReadonlyMap<string, Tag>,
  { owner, ownerEmail }: ViewInputs,
  now: number,
  runActivityTime: number,
  h: HtmlBuilder<Message>,
) => {
  const { status, priority, assignee } = task;
  const statusDisplay = taskStatusDisplay[status];
  const priorityDisplay = taskPriorityDisplay[priority ?? ""];
  const imageMounted = Message.CompletedAssigneeAvatarImageMount();
  const assigneeAvatar =
    assignee === "owner"
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
  return h.tr(
    [h.Key(task.id), h.Class("task-row")],
    [
      h.td(
        [h.Class("task-activity-cell")],
        task.latestRun
          ? [runActivity(task.latestRun, runActivityTime, "indicator", h)]
          : [],
      ),
      h.td(
        [],
        [
          h.div(
            [h.Class("task-row-main")],
            [
              h.a(
                [
                  h.Class("task-row-link"),
                  h.Href(taskPath(task.id)),
                  h.DataAttribute("task-id", task.id),
                  ...(Number.isFinite(new Date(task.updatedAt).getTime())
                    ? [
                        h.Title(
                          `Updated ${taskDateTimeFormat.format(task.updatedAt)}`,
                        ),
                      ]
                    : []),
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
      taskRowValue(
        statusDisplay.label,
        outlineIcon(h, statusDisplay.icon),
        "status",
        status,
        h,
      ),
      taskRowValue(
        priorityDisplay.label,
        outlineIcon(h, priorityDisplay.icon),
        "priority",
        priority ?? "",
        h,
      ),
      taskRowValue(
        assigneeLabels[assignee ?? ""],
        assigneeAvatar,
        "assignee",
        assignee ?? "",
        h,
      ),
      h.td([], [timestamp(task.updatedAt, now, h)]),
    ],
  );
};

const taskFilterOptions = (
  filterCategory: typeof FilterCategory.Type,
  { filters, filterTags }: Model,
  tags: readonly Tag[],
  h: HtmlBuilder<Message>,
) => {
  const tagQuery = tagNameKey(filterTags.inputValue);
  const options = {
    status: () =>
      statusOptions.map(({ value, label }) =>
        filterChoice(
          {
            label,
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
            label: taskPriorityDisplay[value ?? ""].label,
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
) =>
  filterMenu(
    {
      popover: model.filterPopover,
      category: model.filterCategory,
      categories: FilterCategory.literals.map((id) => ({
        id,
        label: filterLabels[id],
      })),
      count: taskFilterCount(model.filters),
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

const taskTable = (
  rows: readonly Html[],
  loading: boolean,
  h: HtmlBuilder<Message>,
) =>
  h.table(
    [
      h.Class("task-table"),
      ...(loading ? [h.AriaHidden(true)] : [h.AriaLabel(taskListLabel)]),
    ],
    [
      h.thead(
        [],
        [
          h.tr(
            [],
            [
              h.th(
                [h.Key("Activity"), h.Scope("col"), h.AriaLabel("Activity")],
                [],
              ),
              ...["Task", "Status", "Priority", "Assignee", "Updated"].map(
                (label) =>
                  h.th([h.Key(label), h.Scope("col")], [h.span([], [label])]),
              ),
            ],
          ),
        ],
      ),
      h.tbody([], [...rows]),
    ],
  );

const taskPlaceholders = (h: HtmlBuilder<Message>) =>
  Array.from({ length: 4 }, (_, index) =>
    h.tr(
      [h.Key(String(index))],
      [
        h.td([], []),
        h.td([], [skeleton(index % 2 ? "md" : "lg", h)]),
        h.td([], [skeleton("md", h)]),
        h.td([], [skeleton("sm", h)]),
        h.td([], [skeleton("sm", h)]),
        h.td([], [skeleton("md", h)]),
      ],
    ),
  );

const taskList = (
  model: Model,
  tags: ReadonlyArray<Tag>,
  viewInputs: ViewInputs,
  h: HtmlBuilder<Message>,
) => {
  const allTasks = model.index?.tasks ?? [];
  const tasks = sortedTasks(allTasks, model);
  const loading = !model.index && model.request?.operation._tag === "Load";
  const tagMap = new Map(tags.map((tag) => [tag.id, tag]));
  const emptyTitle =
    !model.index || tasks.length
      ? null
      : allTasks.length
        ? "No tasks match these filters"
        : "No tasks yet";
  let results: Html = h.empty;
  if (tasks.length) {
    const now = Date.now();
    results = taskTable(
      tasks.map((task) =>
        taskRow(task, tagMap, viewInputs, now, model.runActivityTime, h),
      ),
      false,
      h,
    );
  } else if (loading) results = taskTable(taskPlaceholders(h), true, h);
  else if (emptyTitle) {
    const action = allTasks.length
      ? button(
          {
            variant: "outline",
            size: "sm",
            onClick: Message.ClearedFilters(),
            children: ["Clear filters"],
          },
          h,
        )
      : undefined;
    results = empty(
      {
        title: emptyTitle,
        icon: outlineIcon(h, taskIconPaths),
        ...(action ? { action } : {}),
      },
      h,
    );
  }
  return h.section(
    [
      h.Class("workspace-list task-list"),
      h.AriaLabel("Task list"),
      h.Inert(model.selectedId !== null),
      h.Tabindex(-1),
    ],
    [
      visuallyHiddenStatus(emptyTitle, h),
      h.div(
        [
          h.Class("workspace-results task-table-scroll"),
          ...(tasks.length
            ? [
                h.Role("group"),
                h.AriaLabel("Scrollable task table"),
                h.Tabindex(0),
              ]
            : []),
        ],
        [results],
      ),
    ],
  );
};

const taskFields = (
  editor: Editor,
  tags: ReadonlyArray<Tag>,
  busy: boolean,
  h: HtmlBuilder<Message>,
  {
    creation,
    attachments,
  }: {
    creation?: {
      initialFocus: ReadonlyArray<ChildAttribute>;
      tagsUnavailable: boolean;
    };
    attachments?: Html;
  } = {},
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
            value: draft.status,
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
        nativeSelect(
          {
            label: "Assignee",
            options: assigneeOptions,
            value: draft.assignee ?? "",
            disabled: busy,
            onChange: (value) =>
              Message.EditedField({ field: "assignee", value }),
          },
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
    ...(attachments ? [attachments] : []),
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
          creation: { initialFocus, tagsUnavailable: !model.index },
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

const deleteTaskDialog = (model: Model, h: HtmlBuilder<Message>) => {
  const { deletion, deleteDialog } = model;
  const pending = model.request?.operation._tag === "Delete";
  const task = selectedTask(model);
  const changed = !!deletion && task?.revision !== deletion.revision;
  return Dialog.view(
    {
      model: deleteDialog,
      title: "Delete task?",
      alertDescription: `“${deletion?.title ?? ""}” and its screenshots will be permanently deleted.`,
      toParentMessage: toDeleteDialogMessage,
      content: (initialFocus) =>
        h.div(
          [],
          [
            alert(
              {
                message: deletion?.completed
                  ? null
                  : (deletion?.error ??
                    (changed
                      ? task
                        ? deleteConflictMessage
                        : "This task has been deleted."
                      : null)),
                severity: "error",
                announcement: "alert",
              },
              h,
            ),
            Dialog.footer(
              [
                button(
                  {
                    variant: "outline",
                    disabled: pending,
                    attributes: initialFocus,
                    onClick: toDeleteDialogMessage(
                      Dialog.Message.RequestedClose(),
                    ),
                    children: ["Cancel"],
                  },
                  h,
                ),
                button(
                  {
                    variant: "destructive",
                    disabled: pending || changed,
                    focusableWhenDisabled: pending,
                    attributes: [h.AriaBusy(pending)],
                    onClick: Message.ConfirmedDelete(),
                    children: [pending ? "Deleting…" : "Delete task"],
                  },
                  h,
                ),
              ],
              h,
            ),
          ],
        ),
    },
    h,
  );
};

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
            h.p(
              model.error || (busy && !model.index) ? [] : [h.Role("status")],
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
              [
                h.Key(task.id),
                h.Class("task-editor"),
                h.OnMount(
                  Mount.mapMessage(
                    Attachments.WatchEditor({ taskId: task.id }),
                    toAttachmentsMessage,
                  ),
                ),
              ],
              [
                ...taskFields(editor, tags, busy, h, {
                  attachments: Attachments.section(
                    task.id,
                    model.attachments,
                    toAttachmentsMessage,
                    h,
                  ),
                }),
                ...(task.latestRun
                  ? [latestRunDetails(task.latestRun, model.runActivityTime, h)]
                  : []),
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
                    button(
                      {
                        variant: "ghost",
                        size: "sm",
                        disabled: busy,
                        dialogId: deleteDialogId,
                        onClick: Message.RequestedDelete(),
                        children: ["Delete task"],
                      },
                      h,
                    ),
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
      deleteTaskDialog(model, h),
    ],
  );
};

const taskNavigation = (h: HtmlBuilder<Message>) =>
  navigationLinks(
    {
      label: "Task navigation",
      variant: "sidebar",
      destinations: [{ href: tasksPath, label: taskListLabel, current: true }],
    },
    h,
  );

export const view = Submodel.defineView(function tasksView(
  model: Model,
  viewInputs: ViewInputs,
  h: HtmlBuilder<Message>,
) {
  const tags = sortedTags(model);
  const { selectedId, folderSheet } = model;
  const addTask = button(
    {
      size: "sm",
      ariaLabel: "Add task",
      disabled: model.request !== null || !model.index,
      dialogId: creationDialogId,
      onClick: Message.OpenedCreate({ preserveView: false }),
      children: [plusIcon(h, "16"), "Task"],
    },
    h,
  );
  const loadStatus =
    model.request?.operation._tag === "Load" && !model.creation
      ? model.index
        ? "Refreshing tasks…"
        : "Loading tasks…"
      : null;
  // The load error stays visible after Add task closes, without announcing again.
  const loadErrorInDialog =
    (!model.index && model.creation) || model.error?.announcedInCreation;
  return workspace(
    {
      className: "workspace-stacked tasks-workspace",
      header: screenHeader(
        {
          title: selectedTask(model)?.title ?? taskListLabel,
          navigation: [
            ...(selectedId
              ? [
                  screenHeaderBack(
                    { href: tasksPath, label: `Back to ${taskListLabel}` },
                    h,
                  ),
                ]
              : []),
            h.div(
              [h.Class("workspace-drawer-trigger")],
              [
                button(
                  {
                    variant: "ghost",
                    size: "icon-sm",
                    ariaLabel: "Task navigation",
                    dialogId: folderSheet.id,
                    onClick: toFolderSheetMessage(
                      Sheet.Message.RequestedOpen(),
                    ),
                    children: [outlineIcon(h, ["M4 6h16M4 12h16M4 18h16"])],
                  },
                  h,
                ),
              ],
            ),
          ],
          controls: selectedId
            ? []
            : [taskFilters(model, tags, h), taskSort(model, h)],
          primaryAction: addTask,
          feedback: [
            visuallyHiddenStatus(loadStatus, h),
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
        },
        h,
      ),
      sidebar: taskNavigation(h),
      list: taskList(model, tags, viewInputs, h),
      hasSelection: selectedId !== null,
      ...(selectedId ? { detail: taskDetail(selectedId, model, tags, h) } : {}),
      sheet: Sheet.sheet(
        {
          model: folderSheet,
          title: "Task navigation",
          content: taskNavigation(h),
          toParentMessage: toFolderSheetMessage,
        },
        h,
      ),
    },
    h,
  );
});
