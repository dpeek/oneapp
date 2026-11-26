import {
  alert,
  button,
  calendarIconPaths,
  circleXIconPaths,
  cloudIconPaths,
  Dialog,
  DropdownMenu,
  empty,
  field,
  input,
  ItemActionMenu,
  MultiCombobox,
  navigationLinks,
  nativeSelect,
  outlineIcon,
  plusIcon,
  Sheet,
  skeleton,
  spinnerIcon,
  taskIconPaths,
  textarea,
  timestamp,
  trashIconPaths,
  Tokenizer,
  visuallyHiddenStatus,
} from "@orumai/ui";
import { Effect, Option } from "effect";
import { Mount, Submodel } from "foldkit";
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html";
import * as Attachments from "./task-attachments.ts";
import { tagNameKey, tagNameLimit, type Tag } from "./items-contract.ts";
import { isTaskRunInterrupted, type TaskRun } from "./task-run-contract.ts";
import {
  type Task,
  taskDescriptionLimit,
  taskPath,
  tasksPath,
  taskTagLimit,
  taskTitleLimit,
} from "./tasks-contract.ts";
import { taskFilterCount } from "./tasks-filters.ts";
import {
  FilterCategory,
  addTaskButtonId,
  creationDialogId,
  creationSubmitId,
  creationTitleId,
  deleteConflictMessage,
  deleteDialogId,
  filterOptionsId,
  editedTask,
  Message,
  selectedTask,
  tagSearch,
  taskActionMenu,
  taskSortMenu,
  toFilterPopoverMessage,
  toFilterTagsMessage,
  toAttachmentsMessage,
  toDeleteDialogMessage,
  toFolderSheetMessage,
  toRowActionMessage,
  toSortMenuMessage,
  writingCreation,
  visibleTasks,
  type Editor,
  type Model,
} from "./tasks.ts";
import { filterChoice, filterMenu } from "./filter-menu.ts";
import { screenHeader, screenHeaderBack, workspace } from "./workspace.ts";

import { type TextField, saving } from "./task-edits.ts";
import { type Property } from "./task-properties.ts";
import {
  assigneeOptions,
  priorityOptions,
  statusOptions,
  taskProperty,
  type TaskRowValue,
  type ViewInputs,
} from "./task-properties-view.ts";

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
const filterLabels = { status: "Status", priority: "Priority", tags: "Tags" };
const taskListLabel = "All tasks";
const taskDateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const taskTimestamp = (value: number, h: HtmlBuilder<Message>) =>
  h.time(
    [h.Datetime(new Date(value).toISOString())],
    [taskDateTimeFormat.format(value)],
  );

const rowPropertyFields = [
  ["status", "Status"],
  ["priority", "Priority"],
  ["assignee", "Assignee"],
  ["dueOn", "Due date"],
] as const satisfies readonly (readonly [Property, string])[];

const taskRow = (
  saved: Task,
  model: Model,
  tags: readonly Tag[],
  viewInputs: ViewInputs,
  now: number,
  runActivityTime: number,
  h: HtmlBuilder<Message>,
) => {
  const task = editedTask(model, saved);
  const items: readonly DropdownMenu.Item<"open" | "rename" | Property>[] = [
    { action: "open", label: "Open", icon: outlineIcon(h, taskIconPaths) },
    {
      action: "rename",
      label: "Rename",
      icon: outlineIcon(h, ["m4 20 4-.8L20 7l-3-3L5 16zM14 7l3 3"]),
    },
    {
      action: "assignee",
      label: "Assignee",
      icon: outlineIcon(h, [
        "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 0-8 0 4 4 0 0 0 8 0Z",
      ]),
    },
    {
      action: "dueOn",
      label: "Due date",
      icon: outlineIcon(h, calendarIconPaths),
    },
  ];
  const rename = model.rename?.id === task.id ? model.rename : null;
  const menuPicker =
    model.picker?.id === task.id &&
    model.picker.surface === "menu" &&
    model.picker.popover.isOpen
      ? model.picker
      : null;
  const problem = `task-rename-error-${task.id}`;
  return h.tr(
    [
      h.Key(task.id),
      h.Class("task-row"),
      ...ItemActionMenu.rowAttributes(task.id, toRowActionMessage, h),
    ],
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
              rename
                ? h.div(
                    [h.Class("task-rename")],
                    [
                      input<Message>(
                        [
                          h.Id(`task-rename-${task.id}`),
                          h.Type("text"),
                          h.AriaLabel("Task title"),
                          h.Value(rename.value),
                          h.Maxlength(taskTitleLimit),
                          ...(rename.invalid
                            ? [h.AriaInvalid(true), h.AriaDescribedBy(problem)]
                            : []),
                          h.OnInput((value) =>
                            Message.EditedRename({ id: task.id, value }),
                          ),
                          h.OnBlur(Message.CommittedRename({ id: task.id })),
                          h.OnKeyDownPreventDefault((key) =>
                            key === "Enter"
                              ? Option.some(
                                  Message.CommittedRename({ id: task.id }),
                                )
                              : key === "Escape"
                                ? Option.some(
                                    Message.CanceledRename({ id: task.id }),
                                  )
                                : Option.none(),
                          ),
                        ],
                        h,
                      ),
                      ...(rename.invalid
                        ? [
                            h.p(
                              [
                                h.Id(problem),
                                h.Role("alert"),
                                h.Class("task-title-error"),
                              ],
                              ["Enter a task title."],
                            ),
                          ]
                        : []),
                    ],
                  )
                : h.a(
                    [
                      h.Class("task-row-link"),
                      h.Href(taskPath(task.id)),
                      h.DataAttribute("task-id", task.id),
                      ...ItemActionMenu.rowLinkAttributes(
                        model.rowActions.id,
                        task.id,
                        items,
                        toRowActionMessage,
                        h,
                      ),
                      h.Title(task.title),
                    ],
                    [task.title],
                  ),
              taskProperty(model, task, "tagIds", "row", tags, viewInputs, h),
            ],
          ),
        ],
      ),
      ...rowPropertyFields.map(([field]) =>
        h.td(
          [h.Key(field), h.Class(`task-property-cell task-cell-${field}`)],
          [taskProperty(model, task, field, "row", tags, viewInputs, h)],
        ),
      ),
      h.td([h.Class("task-updated-cell")], [timestamp(task.updatedAt, now, h)]),
      h.td(
        [h.Class("task-actions-cell")],
        [
          taskActionMenu.view(
            {
              model: model.rowActions,
              rowKey: task.id,
              label: `Actions for ${task.title}`,
              items,
              alwaysShowTrigger: true,
              toParentMessage: toRowActionMessage,
            },
            h,
          ),
          ...(menuPicker
            ? [
                h.div(
                  [h.Class("task-menu-picker")],
                  [
                    taskProperty(
                      model,
                      task,
                      menuPicker.field,
                      "menu",
                      tags,
                      viewInputs,
                      h,
                    ),
                  ],
                ),
              ]
            : []),
        ],
      ),
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
      priorityOptions.map(({ value, label }) => {
        const priority = value || null;
        return filterChoice(
          {
            label,
            checked: filters.priorities.includes(priority),
            message: Message.ToggledPriorityFilter({ value: priority }),
          },
          h,
        );
      }),
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
              h.th([h.Key("Task"), h.Scope("col")], ["Task"]),
              ...rowPropertyFields.map(([field, label]) =>
                h.th(
                  [
                    h.Key(field),
                    h.Scope("col"),
                    h.Class(`task-property-cell task-cell-${field}`),
                  ],
                  [h.span([], [label])],
                ),
              ),
              h.th(
                [
                  h.Key("Updated"),
                  h.Scope("col"),
                  h.Class("task-updated-cell"),
                ],
                ["Updated"],
              ),
              h.th(
                [
                  h.Key("Actions"),
                  h.Scope("col"),
                  h.AriaLabel("Actions"),
                  h.Class("task-actions-cell"),
                ],
                [],
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
        ...rowPropertyFields.map(([field]) =>
          h.td(
            [h.Key(field), h.Class(`task-property-cell task-cell-${field}`)],
            [skeleton("sm", h)],
          ),
        ),
        h.td([h.Class("task-updated-cell")], [skeleton("md", h)]),
        h.td([h.Class("task-actions-cell")], []),
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
  const tasks = visibleTasks(model);
  const loading = !model.index && model.request?.operation._tag === "Load";
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
        taskRow(task, model, tags, viewInputs, now, model.runActivityTime, h),
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
  }: {
    creation: {
      initialFocus: ReadonlyArray<ChildAttribute>;
      tagsUnavailable: boolean;
    };
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
          h.Id(creationTitleId),
          h.Required(true),
          ...creation.initialFocus,
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
        busy: busy || creation.tagsUnavailable,
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
  const savingTask = !!deletion && saving(model.edits[deletion.id]);
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
                    disabled: pending || changed || savingTask,
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

const taskDocumentField = (
  model: Model,
  task: Task,
  field: TextField,
  h: HtmlBuilder<Message>,
) => {
  const title = field === "title";
  const draft = model.edits[task.id]?.text[field];
  const value = draft?.value ?? task[field];
  const invalid = title && draft !== undefined && !value.trim();
  const errorId = "task-title-error";
  const editor = h.span(
    [h.Class("task-document-input"), h.DataAttribute("value", value)],
    [
      h.textarea([
        h.Rows(1),
        h.AriaLabel(title ? "Task title" : "Description (Markdown)"),
        h.Value(value),
        h.Maxlength(title ? taskTitleLimit : taskDescriptionLimit),
        h.Placeholder(title ? "Task title" : "Add a description…"),
        ...(invalid ? [h.AriaInvalid(true), h.AriaDescribedBy(errorId)] : []),
        h.OnInput((value) =>
          Message.EditedText({
            id: task.id,
            field,
            value: title ? value.replace(/[\r\n]+/gu, " ") : value,
          }),
        ),
        h.OnBlur(Message.BlurredText({ id: task.id, field })),
        ...(title
          ? [
              h.OnKeyDownPreventDefault((key) =>
                key === "Enter"
                  ? Option.some(Message.BlurredText({ id: task.id, field }))
                  : Option.none(),
              ),
            ]
          : []),
      ]),
    ],
  );
  if (!title) return editor;
  return h.div(
    [h.Class("task-document-title")],
    [
      h.h1([], [editor]),
      ...(invalid
        ? [
            h.p(
              [h.Id(errorId), h.Role("status"), h.Class("task-title-error")],
              ["Enter a task title."],
            ),
          ]
        : []),
    ],
  );
};

const editFeedback = (model: Model, h: HtmlBuilder<Message>) =>
  Object.entries(model.edits).flatMap(([id, draft]) => {
    if (!draft.error) return [];
    const task = model.index?.tasks.find((task) => task.id === id);
    const conflict = draft.error === "conflict";
    const name =
      !model.selectedId || model.selectedId !== id
        ? ` for “${task?.title ?? "a task"}”`
        : "";
    const action = h.div(
      [h.Class("task-edit-recovery")],
      [
        ...(task
          ? [
              button(
                {
                  variant: "outline",
                  size: "sm",
                  onClick: Message.RetriedEdit({ id }),
                  children: [conflict ? "Apply my edits" : "Retry save"],
                },
                h,
              ),
            ]
          : []),
        ...(conflict || !task
          ? [
              button(
                {
                  variant: "ghost",
                  size: "sm",
                  onClick: Message.DiscardedEdit({ id }),
                  children: [task ? "Use saved values" : "Discard draft"],
                },
                h,
              ),
            ]
          : []),
      ],
    );
    return [
      h.div(
        [h.Key(id)],
        [
          alert(
            {
              message: !task
                ? "The task is no longer available. Your draft is still in this session."
                : conflict
                  ? `The saved task changed${name}. Apply your edits to the latest version or use the saved values.`
                  : `Could not save changes${name}.`,
              severity: "error",
              announcement: "status",
              action,
            },
            h,
          ),
        ],
      ),
    ];
  });

const taskDetail = (
  id: string,
  model: Model,
  tags: readonly Tag[],
  viewInputs: ViewInputs,
  h: HtmlBuilder<Message>,
) => {
  const saved = selectedTask(model);
  const task = saved && editedTask(model, saved);
  const busy = model.request?.operation._tag === "Load";
  return h.section(
    [
      h.Key(id),
      h.Class("workspace-detail task-detail"),
      h.AriaLabel("Task details"),
      h.Tabindex(-1),
      h.OnMount(FocusDetail()),
    ],
    [
      ...(!task
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
                h.div(
                  [h.Class("task-document-header")],
                  [
                    taskDocumentField(model, task, "title", h),
                    h.div(
                      [h.Class("task-property-strip")],
                      [
                        ...(
                          [
                            "tagIds",
                            "status",
                            "priority",
                            "assignee",
                            "dueOn",
                          ] as const
                        ).map((field) =>
                          taskProperty(
                            model,
                            task,
                            field,
                            "detail",
                            tags,
                            viewInputs,
                            h,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
                taskDocumentField(model, task, "description", h),
                Attachments.section(
                  task.id,
                  model.attachments,
                  toAttachmentsMessage,
                  h,
                ),
                ...(task.latestRun
                  ? [latestRunDetails(task.latestRun, model.runActivityTime, h)]
                  : []),
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
      attributes: [h.Id(addTaskButtonId)],
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
          title: selectedId ? undefined : taskListLabel,
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
          primaryAction: selectedId
            ? button(
                {
                  variant: "ghost",
                  size: "icon-sm",
                  ariaLabel: "Delete task",
                  dialogId: deleteDialogId,
                  attributes: [h.Title("Delete task")],
                  disabled: !selectedTask(model) || model.request !== null,
                  onClick: Message.RequestedDelete(),
                  children: [outlineIcon(h, trashIconPaths)],
                },
                h,
              )
            : addTask,
          feedback: [
            h.div(
              [h.Class("task-save-state"), h.Role("status")],
              [Object.values(model.edits).some(saving) ? "Saving…" : ""],
            ),
            ...editFeedback(model, h),
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
      ...(selectedId
        ? { detail: taskDetail(selectedId, model, tags, viewInputs, h) }
        : {}),
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
