import {
  alert,
  button,
  circleXIconPaths,
  cloudIconPaths,
  Dialog,
  DropdownMenu,
  empty,
  MultiCombobox,
  navigationLinks,
  outlineIcon,
  plusIcon,
  Sheet,
  skeleton,
  spinnerIcon,
  taskIconPaths,
  timestamp,
  trashIconPaths,
  Tooltip,
  visuallyHiddenStatus,
} from "@orumai/ui";
import { Effect, Option } from "effect";
import { Mount, Submodel } from "foldkit";
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html";
import * as Attachments from "./task-attachments.ts";
import { mailMessageLink, mailRouteFor } from "./inbox-contract.ts";
import { tagNameKey, type Tag } from "./items-contract.ts";
import { isTaskRunInterrupted, type TaskRun } from "./task-run-contract.ts";
import {
  type Task,
  TaskList,
  taskDescriptionLimit,
  taskListPath,
  taskPath,
  taskTitleLimit,
} from "./tasks-contract.ts";
import { taskFilterCount } from "./tasks-filters.ts";
import {
  FilterCategory,
  activityTooltip,
  addTaskButtonId,
  creationDialogId,
  creationFieldsLocked,
  creationSubmitId,
  creationTitleId,
  deleteConflictMessage,
  deleteDialogId,
  filterOptionsId,
  editedTask,
  Message,
  selectedTask,
  taskSortMenu,
  toFilterPopoverMessage,
  toFilterTagsMessage,
  toAttachmentsMessage,
  toDraftScreenshotMessage,
  toDeleteDialogMessage,
  toFolderSheetMessage,
  toSortMenuMessage,
  writingCreation,
  visibleTasks,
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
  type ViewInputs,
} from "./task-properties-view.ts";

const runPhaseLabels = {
  setup: "Setting up",
  implementation: "Agent working",
  "waiting-to-publish": "Waiting to publish",
  checks: "Running checks",
  deployment: "Waiting for deploy",
} satisfies Record<Exclude<TaskRun["phase"], "finished">, string>;
const runOutcomeLabels = {
  deployed: "Deployed",
  "setup-failed": "Setup failed",
  "implementation-failed": "Implementation failed",
  "publish-failed": "Publish failed",
  "checks-failed": "Checks failed",
  "deployment-failed": "Deployment failed",
  interrupted: "Run interrupted",
} satisfies Record<NonNullable<TaskRun["outcome"]> | "interrupted", string>;

const runReason = (run: TaskRun, now: number) =>
  run.reason ??
  (isTaskRunInterrupted(run, now)
    ? "The runner stopped reporting activity."
    : null);

const runActivity = (
  run: TaskRun,
  now: number,
  h: HtmlBuilder<Message>,
  row?: { model: Model; taskId: string },
) => {
  const outcome = isTaskRunInterrupted(run, now) ? "interrupted" : run.outcome;
  const { phase } = run;
  const label = outcome
    ? runOutcomeLabels[outcome]
    : phase === "finished"
      ? null
      : runPhaseLabels[phase];
  if (!label) return h.empty;

  const activity = outcome
    ? h.DataAttribute("outcome", outcome)
    : h.DataAttribute("activity", phase);
  const icon = outcome
    ? outlineIcon(h, outcome === "deployed" ? cloudIconPaths : circleXIconPaths)
    : spinnerIcon(h, 16);
  if (row)
    return Tooltip.tooltip(
      {
        model: activityTooltip(row.model, row.taskId),
        content: [label, runReason(run, now), run.summary]
          .filter(Boolean)
          .join(" · "),
        toParentMessage: (message) =>
          Message.GotActivityTooltipMessage({ id: row.taskId, message }),
        renderTrigger: (attributes) =>
          h.button(
            [
              ...attributes,
              h.Class("task-row-value task-activity-indicator"),
              activity,
              h.AriaLabel(label),
              h.OnUnmount(Message.UnmountedActivityTooltip({ id: row.taskId })),
            ],
            [icon],
          ),
      },
      h,
    );
  return h.span(
    [h.Class("task-row-value"), activity],
    [icon, h.span([], [label])],
  );
};

const latestRunDetails = (
  run: TaskRun,
  now: number,
  h: HtmlBuilder<Message>,
) => {
  const reason = runReason(run, now);
  return h.section(
    [h.Class("task-latest-run"), h.AriaLabel("Latest run")],
    [
      h.h2([], ["Latest run"]),
      h.div([h.Role("status")], [runActivity(run, now, h)]),
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
const filterLabels = {
  status: "Status",
  priority: "Priority",
  assignee: "Assignee",
  tags: "Tags",
};
const taskListLabels = {
  active: "Active",
  complete: "Complete",
  all: "All tasks",
} satisfies Record<TaskList, string>;
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
  return h.tr(
    [h.Key(task.id), h.Class("task-row")],
    [
      h.td(
        [h.Class("task-activity-cell")],
        task.latestRun
          ? [
              runActivity(task.latestRun, runActivityTime, h, {
                model,
                taskId: task.id,
              }),
            ]
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
    assignee: () =>
      assigneeOptions.map(({ value, label }) => {
        const assignee = value || null;
        return filterChoice(
          {
            label,
            checked: filters.assignees.includes(assignee),
            message: Message.ToggledAssigneeFilter({ value: assignee }),
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
  label: string,
  loading: boolean,
  h: HtmlBuilder<Message>,
) =>
  h.table(
    [
      h.Class("task-table"),
      ...(loading ? [h.AriaHidden(true)] : [h.AriaLabel(label)]),
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
  const label = taskListLabels[model.list];
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
      label,
      false,
      h,
    );
  } else if (loading) results = taskTable(taskPlaceholders(h), label, true, h);
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
    {
      initialFocus,
      ...viewInputs
    }: ViewInputs & { initialFocus: ReadonlyArray<ChildAttribute> },
    h: HtmlBuilder<Message>,
  ) => {
    const creation = model.creation;
    if (!creation) return h.empty;
    const { draft, saved, upload, screenshots, validatingScreenshots } =
      creation;
    const locked = creationFieldsLocked(model);
    const submitting = model.request?.operation._tag === "Create";
    const loadError = model.index ? null : (model.error?.message ?? null);
    const status = upload
      ? `Uploading screenshot ${upload.current} of ${upload.total}…`
      : validatingScreenshots
        ? "Checking screenshots…"
        : null;
    return h.form(
      [
        h.Class("task-create-form"),
        h.OnSubmit(
          saved ? Message.RetriedDraftScreenshots() : Message.Created(),
        ),
        h.OnMount(
          Mount.mapMessage(
            Attachments.WatchEditor({ taskId: draft.id, draft: true }),
            toDraftScreenshotMessage,
          ),
        ),
      ],
      [
        h.div(
          [h.Class("task-editor task-create-body")],
          [
            ...taskDocument(model, draft, sortedTags(model), viewInputs, h, {
              initialFocus,
              locked,
              titleEdited: creation.titleEdited,
            }),
            Attachments.draftSection(
              screenshots,
              {
                locked,
                status,
                error: creation.screenshotError,
                onRemove: (id) => Message.RemovedDraftScreenshot({ id }),
                toParent: toDraftScreenshotMessage,
              },
              h,
            ),
            alert(
              {
                message: saved
                  ? upload
                    ? null
                    : "Task created. Retry the screenshots listed above or finish without them."
                  : (creation.error ?? loadError),
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
          ],
        ),
        h.div(
          [h.Class("task-create-footer")],
          [
            Dialog.footer(
              [
                button(
                  {
                    variant: "outline",
                    size: "sm",
                    disabled: writingCreation(model),
                    onClick: saved
                      ? Message.FinishedDraftScreenshots()
                      : Message.ClosedCreate(),
                    children: [
                      saved ? "Finish without remaining files" : "Cancel",
                    ],
                  },
                  h,
                ),
                button(
                  {
                    type: "submit",
                    size: "sm",
                    attributes: [h.Id(creationSubmitId)],
                    focusableWhenDisabled: submitting || upload !== null,
                    disabled: saved
                      ? upload !== null
                      : model.request !== null ||
                        !model.index ||
                        !draft.title.trim() ||
                        validatingScreenshots > 0,
                    children: [
                      saved
                        ? upload
                          ? "Uploading…"
                          : "Retry screenshots"
                        : submitting
                          ? "Adding…"
                          : "Add task",
                    ],
                  },
                  h,
                ),
              ],
              h,
            ),
          ],
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

type CreationForm = {
  initialFocus: ReadonlyArray<ChildAttribute>;
  locked: boolean;
  titleEdited: boolean;
};

const taskDocumentField = (
  model: Model,
  task: Pick<Task, "id" | TextField>,
  field: TextField,
  h: HtmlBuilder<Message>,
  creation?: CreationForm,
) => {
  const title = field === "title";
  const draft = creation ? undefined : model.edits[task.id]?.text[field];
  const value = draft?.value ?? task[field];
  const invalid =
    title && (creation?.titleEdited ?? draft !== undefined) && !value.trim();
  const errorId = creation ? "task-create-title-error" : "task-title-error";
  const commitTitle = Message.BlurredText({ id: task.id, field });
  const editor = h.span(
    [h.Class("task-document-input"), h.DataAttribute("value", value)],
    [
      h.textarea([
        h.Rows(1),
        h.AriaLabel(title ? "Task title" : "Description (Markdown)"),
        h.Value(value),
        h.Maxlength(title ? taskTitleLimit : taskDescriptionLimit),
        h.Placeholder(
          title ? (creation ? "New task" : "Task title") : "Add a description…",
        ),
        ...(creation
          ? [
              h.Readonly(creation.locked),
              ...(title
                ? [
                    h.Id(creationTitleId),
                    h.Required(true),
                    ...creation.initialFocus,
                  ]
                : []),
            ]
          : [h.OnBlur(commitTitle)]),
        ...(invalid ? [h.AriaInvalid(true), h.AriaDescribedBy(errorId)] : []),
        h.OnInput((value) =>
          Message.EditedText({
            id: task.id,
            field,
            value: title ? value.replace(/[\r\n]+/gu, " ") : value,
          }),
        ),
        ...(title
          ? [
              h.OnKeyDownPreventDefault((key) =>
                key === "Enter" ? Option.some(commitTitle) : Option.none(),
              ),
            ]
          : []),
      ]),
    ],
  );
  if (!title) return editor;
  const titleStyle = [h.Class("task-document-title-text")];
  return h.div(
    [h.Class("task-document-title")],
    [
      creation ? h.div(titleStyle, [editor]) : h.h1(titleStyle, [editor]),
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

const taskDocument = (
  model: Model,
  task: Pick<Task, "id" | TextField | Property>,
  tags: readonly Tag[],
  viewInputs: ViewInputs,
  h: HtmlBuilder<Message>,
  creation?: CreationForm,
) => [
  h.div(
    [h.Class("task-document-header")],
    [
      taskDocumentField(model, task, "title", h, creation),
      h.div(
        [h.Class("task-property-strip")],
        (["tagIds", "status", "priority", "assignee", "dueOn"] as const).map(
          (field) =>
            taskProperty(
              model,
              task,
              field,
              creation ? "creation" : "detail",
              tags,
              viewInputs,
              h,
            ),
        ),
      ),
    ],
  ),
  taskDocumentField(model, task, "description", h, creation),
];

const taskMailSources = (description: string, h: HtmlBuilder<Message>) => {
  const origin = window.location.origin;
  const sources = new Map<string, string>();
  for (const [, label = "", href = ""] of description.matchAll(
    /(?<![!\\])\[([^\[\]\r\n]{1,200})\]\(([^()\s]{1,512})\)/gu,
  )) {
    const url = URL.parse(href, origin);
    if (url?.origin !== origin) continue;
    const route = mailRouteFor(url.pathname, url.hash.slice(1));
    if (route?.focusMessage && route.id && label.trim())
      sources.set(mailMessageLink(route.id), label);
  }
  return sources.size
    ? h.ul(
        [h.Class("task-mail-sources"), h.AriaLabel("Mail sources")],
        [...sources].map(([href, label]) =>
          h.li([h.Key(href)], [h.a([h.Href(href)], [label])]),
        ),
      )
    : h.empty;
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
                    Attachments.WatchEditor({ taskId: task.id, draft: false }),
                    toAttachmentsMessage,
                  ),
                ),
              ],
              [
                ...taskDocument(model, task, tags, viewInputs, h),
                taskMailSources(task.description, h),
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

const taskNavigation = (current: TaskList, h: HtmlBuilder<Message>) =>
  navigationLinks(
    {
      label: "Task navigation",
      variant: "sidebar",
      destinations: TaskList.literals.map((list) => ({
        href: taskListPath(list),
        label: taskListLabels[list],
        current: list === current,
      })),
    },
    h,
  );

export const view = Submodel.defineView(function tasksView(
  model: Model,
  viewInputs: ViewInputs,
  h: HtmlBuilder<Message>,
) {
  const tags = sortedTags(model);
  const { selectedId, folderSheet, list } = model;
  const label = taskListLabels[list];
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
          title: selectedId ? undefined : label,
          navigation: [
            ...(selectedId
              ? [
                  screenHeaderBack(
                    { href: taskListPath(list), label: `Back to ${label}` },
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
      sidebar: taskNavigation(list, h),
      list: taskList(model, tags, viewInputs, h),
      hasSelection: selectedId !== null,
      ...(selectedId
        ? { detail: taskDetail(selectedId, model, tags, viewInputs, h) }
        : {}),
      sheet: Sheet.sheet(
        {
          model: folderSheet,
          title: "Task navigation",
          content: taskNavigation(list, h),
          toParentMessage: toFolderSheetMessage,
        },
        h,
      ),
    },
    h,
  );
});
