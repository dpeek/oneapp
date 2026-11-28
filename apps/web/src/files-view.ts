import {
  alert,
  button,
  buttonClassName,
  empty,
  Dialog,
  filesIconPaths,
  item,
  ItemActionMenu,
  itemGroup,
  outlineIcon,
  skeleton,
  trashIconPaths,
  visuallyHiddenStatus,
} from "@orumai/ui";
import { Effect, Option } from "effect";
import { Mount, Submodel } from "foldkit";
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html";
import { fileSize, renderPdf } from "./file-display.ts";
import { filterChoice, filterMenu } from "./filter-menu.ts";
import {
  documentMarkdownLimit,
  documentTitleLimit,
  fileContentApi,
  fileImagesApi,
  filePath,
  filesPath,
  fileUploadLimit,
  type StoredFile,
} from "./files-contract.ts";
import {
  creationTitleId,
  fileActionMenu,
  fileActionsId,
  fileDeleteDialogId,
  filterOptionsId,
  matchesFileFilter,
  Message,
  selectedFile,
  tagPickerId,
  writingCreation,
  toActionMenuMessage,
  toFilterPopoverMessage,
  toDeleteDialogMessage,
  type Model,
} from "./files.ts";
import { ItemId, type Tag } from "./items-contract.ts";
import { markdownEditor } from "./markdown-editor-contract.ts";
import { changed, uploading } from "./file-document-edits.ts";
import { tagProperty } from "./tag-picker-view.ts";
import { screenHeader, screenHeaderBack, workspace } from "./workspace.ts";

const RenderPdf = Mount.define("RenderFilePdf", {
  args: { id: ItemId },
  messages: [Message.PreviewReady, Message.PreviewFailed],
  execute: ({ element, id }) =>
    Effect.tryPromise(async (signal) => {
      const response = await fetch(fileContentApi(id, "preview"), {
        cache: "no-store",
        signal,
      });
      if (!response.ok) return Message.PreviewFailed({ id });
      const canvas = await renderPdf(await response.arrayBuffer());
      if (!signal.aborted && element.isConnected)
        element.replaceChildren(canvas);
      return Message.PreviewReady({ id });
    }).pipe(Effect.catch(() => Effect.succeed(Message.PreviewFailed({ id })))),
});

const downloadIcon = (h: HtmlBuilder<Message>) =>
  outlineIcon(h, ["M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"]);

const downloadLink = (file: StoredFile, h: HtmlBuilder<Message>) =>
  h.a(
    [
      h.Href(fileContentApi(file.id, "download")),
      h.Download(file.name),
      h.DataAttribute("slot", "button"),
      h.AriaLabel(`Download ${file.name}`),
      h.Title(`Download ${file.name}`),
      h.Class(buttonClassName({ variant: "ghost", size: "icon-sm" })),
    ],
    [downloadIcon(h)],
  );

const deleteFileDialog = (model: Model, h: HtmlBuilder<Message>) => {
  const { deletion } = model;
  const pending = model.request?.operation._tag === "Delete";
  const file = selectedFile(model);
  const stale = !!deletion && deletion.revision !== file?.revision;
  return Dialog.view(
    {
      model: model.deleteDialog,
      title: "Delete file?",
      alertDescription: `“${deletion?.name ?? ""}” will be permanently deleted${file?.authored ? " along with its images" : ""}.`,
      toParentMessage: toDeleteDialogMessage,
      content: (initialFocus) =>
        h.div(
          [],
          [
            alert(
              {
                message: deletion?.completed
                  ? null
                  : stale
                    ? "This file changed elsewhere. Close this dialog and review the latest version before deleting."
                    : (deletion?.error ?? null),
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
                    disabled: pending || stale,
                    focusableWhenDisabled: pending,
                    attributes: [h.AriaBusy(pending)],
                    onClick: Message.ConfirmedDelete(),
                    children: [pending ? "Deleting…" : "Delete file"],
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

const documentTitle = (
  model: Model,
  file: StoredFile,
  h: HtmlBuilder<Message>,
) => {
  const draft = model.documents[file.id];
  if (!draft) return h.h2([], [file.name]);
  const blur = Message.BlurredDocument({ id: file.id });
  return h.div(
    [h.Class("task-document-title file-document-title")],
    [
      h.h2(
        [h.Class("task-document-title-text")],
        [
          h.span(
            [
              h.Class("task-document-input"),
              h.DataAttribute("value", draft.title),
            ],
            [
              h.textarea([
                h.Rows(1),
                h.AriaLabel("Document title"),
                h.Value(draft.title),
                h.Maxlength(documentTitleLimit),
                h.Placeholder("Document title"),
                h.AriaInvalid(!draft.title.trim()),
                h.OnInput((value) =>
                  Message.EditedDocument({
                    id: file.id,
                    field: "title",
                    value: value.replace(/[\r\n]+/gu, " "),
                  }),
                ),
                h.OnBlur(blur),
                h.OnKeyDownPreventDefault((key) =>
                  key === "Enter" ? Option.some(blur) : Option.none(),
                ),
              ]),
            ],
          ),
        ],
      ),
      draft.title.trim()
        ? h.empty
        : h.p(
            [h.Role("status"), h.Class("task-title-error")],
            ["Enter a document title."],
          ),
    ],
  );
};

const documentEditor = (
  model: Model,
  file: StoredFile,
  available: boolean,
  h: HtmlBuilder<Message>,
) => {
  const draft = model.documents[file.id];
  if (!draft)
    return h.p(
      [h.Role("status")],
      [
        model.documentLoadFailed === file.id
          ? "Document body is unavailable."
          : "Loading document…",
      ],
    );
  const editor = markdownEditor.withMessage(h);
  const saving =
    model.request?.operation._tag === "SaveDocument" &&
    model.request.operation.id === file.id;
  const message = !available
    ? "This document is unavailable. Your edits are still here."
    : draft.latest
      ? "This document changed elsewhere. Your edits are still here."
      : draft.error;
  return h.div(
    [h.Class("file-document-editor")],
    [
      editor([
        h.Key(file.id),
        editor.Value(draft.markdown),
        editor.Label("Document body"),
        editor.Placeholder("Write something…"),
        editor.Limit(documentMarkdownLimit),
        editor.ReadOnly(false),
        editor.ImageCollection(fileImagesApi(file.id)),
        editor.Revision(draft.saved.file.revision),
        editor.InlineImageUploads(draft.uploads),
        editor.OnDescriptionEdited((value) =>
          Message.EditedDocument({ id: file.id, field: "markdown", value }),
        ),
        editor.OnDescriptionBlurred(() =>
          Message.BlurredDocument({ id: file.id }),
        ),
        editor.OnDescriptionImagePasted((image) =>
          Message.PickedDocumentImage({ documentId: file.id, ...image }),
        ),
      ]),
      h.p(
        [h.Role("status"), h.Class("task-save-state")],
        [
          saving
            ? "Saving…"
            : changed(draft) &&
                (draft.timer || draft.queued) &&
                !message &&
                !uploading(draft) &&
                draft.title.trim() &&
                draft.markdown.length <= documentMarkdownLimit
              ? "Saving…"
              : "",
        ],
      ),
      alert(
        {
          message,
          severity: "error",
          announcement: "status",
          action:
            message && available
              ? h.div(
                  [h.Class("task-edit-recovery")],
                  [
                    button(
                      {
                        variant: "outline",
                        size: "sm",
                        onClick: Message.RetriedDocument({ id: file.id }),
                        children: [
                          draft.latest ? "Apply my edits" : "Retry save",
                        ],
                      },
                      h,
                    ),
                    draft.latest
                      ? button(
                          {
                            variant: "ghost",
                            size: "sm",
                            onClick: Message.DiscardedDocumentEdits({
                              id: file.id,
                            }),
                            children: ["Use saved values"],
                          },
                          h,
                        )
                      : h.empty,
                  ],
                )
              : undefined,
        },
        h,
      ),
    ],
  );
};

const fileTags = (
  model: Model,
  { id, tagIds }: Pick<StoredFile, "id" | "tagIds">,
  item: "document" | "file",
  tags: readonly Tag[],
  h: HtmlBuilder<Message>,
) => {
  const key = tagPickerId(id);
  return h.div(
    [h.Class("task-property-strip")],
    [
      tagProperty(
        {
          id: key,
          picker: model.tagPicker?.popover.id === key ? model.tagPicker : null,
          tags,
          tagIds,
          item,
          disabled:
            !model.index || model.request?.operation._tag === "CreateDocument",
          creatingDisabled: model.request !== null,
          error: null,
          toPopoverMessage: (message) =>
            Message.GotTagPopoverMessage({ id, message }),
          toSearchMessage: (message) =>
            Message.GotTagSearchMessage({ id, message }),
        },
        h,
      ),
    ],
  );
};

const sortedTags = (model: Model) =>
  [...(model.index?.tags ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

export const createView = Submodel.defineView(
  (
    model: Model,
    initialFocus: readonly ChildAttribute[],
    h: HtmlBuilder<Message>,
  ) => {
    const { creation, request, index } = model;
    if (!creation) return h.empty;
    const submitting = request?.operation._tag === "CreateDocument";
    const loadError = index ? null : model.error;
    const editor = markdownEditor.withMessage(h);
    return h.form(
      [h.Class("task-create-form"), h.OnSubmit(Message.CreatedDocument())],
      [
        h.div(
          [h.Class("task-editor task-create-body")],
          [
            h.div(
              [h.Class("task-document-header")],
              [
                h.div(
                  [h.Class("task-document-title-text")],
                  [
                    h.span(
                      [
                        h.Class("task-document-input"),
                        h.DataAttribute("value", creation.title),
                      ],
                      [
                        h.textarea([
                          h.Id(creationTitleId),
                          h.Rows(1),
                          h.AriaLabel("Document title"),
                          h.Value(creation.title),
                          h.Maxlength(documentTitleLimit),
                          h.Placeholder("New document"),
                          h.Readonly(submitting),
                          h.Required(true),
                          ...initialFocus,
                          h.OnInput((value) =>
                            Message.EditedCreation({
                              field: "title",
                              value: value.replace(/[\r\n]+/gu, " "),
                            }),
                          ),
                          h.OnKeyDownPreventDefault((key) =>
                            key === "Enter"
                              ? Option.some(Message.CreatedDocument())
                              : Option.none(),
                          ),
                        ]),
                      ],
                    ),
                  ],
                ),
                fileTags(model, creation, "document", sortedTags(model), h),
              ],
            ),
            editor([
              editor.Value(creation.markdown),
              editor.Label("Document body"),
              editor.Placeholder("Write something…"),
              editor.Limit(documentMarkdownLimit),
              editor.ReadOnly(submitting),
              editor.OnDescriptionEdited((value) =>
                Message.EditedCreation({ field: "markdown", value }),
              ),
            ]),
            alert(
              {
                message: creation.error ?? loadError,
                severity: "error",
                announcement: "status",
                action:
                  loadError && !request
                    ? button(
                        {
                          variant: "outline",
                          size: "sm",
                          onClick: Message.Retried(),
                          children: ["Retry"],
                        },
                        h,
                      )
                    : undefined,
              },
              h,
            ),
            !index && !loadError
              ? h.p([h.Role("status")], ["Loading tags…"])
              : h.empty,
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
                    onClick: Message.ClosedCreate(),
                    children: ["Cancel"],
                  },
                  h,
                ),
                button(
                  {
                    type: "submit",
                    size: "sm",
                    focusableWhenDisabled: submitting,
                    disabled:
                      request !== null ||
                      !index ||
                      !creation.title.trim() ||
                      creation.markdown.length > documentMarkdownLimit,
                    children: [submitting ? "Creating…" : "Create document"],
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

const fileDetail = (
  model: Model,
  tags: readonly Tag[],
  h: HtmlBuilder<Message>,
) => {
  const savedFile = selectedFile(model);
  const id = model.selectedId;
  const draft = id ? model.documents[id] : undefined;
  const file = savedFile ?? (draft && changed(draft) ? draft.saved.file : null);
  const detail = () => {
    if (!file)
      return h.p(model.error || model.request ? [] : [h.Role("status")], [
        model.request
          ? "Loading file…"
          : model.index
            ? "File not found."
            : "File details are unavailable.",
      ]);
    return h.div(
      [h.Key(file.id), h.Class("file-detail-content")],
      [
        h.div(
          [h.Class("file-detail-heading")],
          [
            file.authored
              ? documentTitle(model, file, h)
              : h.h2([], [file.name]),
            savedFile
              ? h.div(
                  [h.Class("file-detail-actions")],
                  [
                    file.authored ? h.empty : downloadLink(file, h),
                    button(
                      {
                        variant: "ghost",
                        size: "icon-sm",
                        ariaLabel: "Delete file",
                        dialogId: fileDeleteDialogId,
                        attributes: [h.Title("Delete file")],
                        disabled:
                          model.request !== null || model.deletion !== null,
                        onClick: Message.RequestedDelete(),
                        children: [outlineIcon(h, trashIconPaths)],
                      },
                      h,
                    ),
                  ],
                )
              : h.empty,
          ],
        ),
        file.authored
          ? h.empty
          : h.dl(
              [h.Class("file-properties")],
              [
                h.div(
                  [],
                  [h.dt([], ["Media type"]), h.dd([], [file.mediaType])],
                ),
                h.div(
                  [],
                  [
                    h.dt([], ["Size"]),
                    h.dd(
                      [
                        h.Title(
                          `${new Intl.NumberFormat().format(file.size)} bytes`,
                        ),
                      ],
                      [fileSize(file.size)],
                    ),
                  ],
                ),
              ],
            ),
        savedFile
          ? fileTags(model, file, file.authored ? "document" : "file", tags, h)
          : h.empty,
        alert(
          {
            message: model.previewFailed
              ? "Could not preview this file."
              : null,
            severity: "error",
            announcement: "status",
          },
          h,
        ),
        ...(file.authored
          ? [documentEditor(model, file, savedFile !== null, h)]
          : []),
        ...(model.previewFailed
          ? []
          : file.previewType === "application/pdf"
            ? [
                h.div(
                  [
                    h.Class("file-preview"),
                    h.OnMount(RenderPdf({ id: file.id })),
                  ],
                  [h.p([h.Role("status")], ["Loading PDF preview…"])],
                ),
              ]
            : file.previewType
              ? [
                  h.img([
                    h.Class("file-preview-image"),
                    h.Src(fileContentApi(file.id, "preview")),
                    h.Alt(file.name),
                    h.OnError(Message.PreviewFailed({ id: file.id })),
                  ]),
                ]
              : []),
      ],
    );
  };
  return h.section(
    [
      h.Key(id ?? ""),
      h.Class("workspace-detail task-detail file-detail"),
      h.AriaLabel("File details"),
    ],
    [detail()],
  );
};

const filePlaceholders = (h: HtmlBuilder<Message>) =>
  h.ul(
    [h.Class("file-list-skeleton"), h.AriaHidden(true)],
    Array.from({ length: 4 }, (_, index) =>
      h.li(
        [h.Key(String(index))],
        [skeleton(index % 2 ? "md" : "lg", h), skeleton("sm", h)],
      ),
    ),
  );

const fileFilters = (
  model: Model,
  tags: readonly Tag[],
  h: HtmlBuilder<Message>,
) =>
  filterMenu(
    {
      popover: model.filterPopover,
      category: model.tagOptionsOpen ? "tags" : null,
      categories: [{ id: "tags", label: "Tags" }],
      count: model.tagFilter === null ? 0 : 1,
      optionsId: filterOptionsId,
      options: () =>
        [{ id: null, name: "All tags" }, ...tags].map(({ id, name }) =>
          filterChoice(
            {
              key: id ?? "all",
              label: name,
              checked: model.tagFilter === id,
              message: Message.SelectedTagFilter({ value: id }),
              radioGroup: "file-tag-filter",
            },
            h,
          ),
        ),
      onOpen: (_, focusOptions) =>
        Message.OpenedTagFilterOptions({ focusOptions }),
      close: Message.ClosedTagFilterOptions(),
      clear: Message.ClearedTagFilter(),
      toPopoverMessage: toFilterPopoverMessage,
    },
    h,
  );

const fileRow = (
  file: StoredFile,
  model: Model,
  tagMap: ReadonlyMap<string, string>,
  h: HtmlBuilder<Message>,
) => {
  const items = [
    {
      action: "open",
      label: "Open",
      icon: outlineIcon(h, filesIconPaths),
      disabled: false,
    },
    ...(file.authored
      ? []
      : [
          {
            action: "download" as const,
            label: "Download",
            icon: downloadIcon(h),
            disabled: false,
          },
        ]),
  ] as const;
  return item(
    {
      key: file.id,
      href: filePath(file.id),
      title: file.name,
      attributes: ItemActionMenu.rowAttributes(file.id, toActionMenuMessage, h),
      linkAttributes: [
        ...ItemActionMenu.rowLinkAttributes(
          fileActionsId,
          file.id,
          items,
          toActionMenuMessage,
          h,
        ),
        ...(model.selectedId === file.id ? [h.AriaCurrent("page")] : []),
      ],
      description: h.div(
        [h.Class("file-row-metadata")],
        [
          h.span(
            [],
            [file.authored ? "Markdown document" : fileSize(file.size)],
          ),
          ...file.tagIds.flatMap((id) => {
            const name = tagMap.get(id);
            return name
              ? [h.span([h.Key(id), h.Class("task-tag")], [name])]
              : [];
          }),
        ],
      ),
      action: fileActionMenu.view(
        {
          model: model.actions,
          rowKey: file.id,
          label: `Actions for ${file.name}`,
          items,
          toParentMessage: toActionMenuMessage,
        },
        h,
      ),
    },
    h,
  );
};

const fileList = (
  model: Model,
  tags: readonly Tag[],
  h: HtmlBuilder<Message>,
) => {
  const files = (model.index?.files ?? []).filter((file) =>
    matchesFileFilter(file, model.tagFilter),
  );
  const tagMap = new Map(tags.map((tag) => [tag.id, tag.name]));
  const hasFiles = !!model.index?.files.length;
  const emptyTitle =
    !model.index || files.length
      ? null
      : hasFiles
        ? "No files match this tag"
        : "No files yet";
  return h.section(
    [
      h.Class("workspace-list file-list"),
      h.AriaLabel("File list"),
      h.OnUnmount(Message.Unmounted()),
    ],
    [
      visuallyHiddenStatus(emptyTitle, h),
      h.div(
        [h.Class("workspace-results")],
        files.length
          ? [
              itemGroup(
                files.map((file) => fileRow(file, model, tagMap, h)),
                h,
              ),
            ]
          : emptyTitle
            ? [
                empty(
                  {
                    title: emptyTitle,
                    icon: outlineIcon(h, filesIconPaths),
                    ...(!hasFiles
                      ? {
                          description: `Files can be up to ${fileUploadLimit / 1024 ** 2} MiB each.`,
                        }
                      : {}),
                    action: hasFiles
                      ? button(
                          {
                            variant: "outline",
                            size: "sm",
                            onClick: Message.ClearedTagFilter(),
                            children: ["Clear filter"],
                          },
                          h,
                        )
                      : undefined,
                  },
                  h,
                ),
              ]
            : !model.index && model.request?.operation._tag === "Load"
              ? [filePlaceholders(h)]
              : [],
      ),
    ],
  );
};

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const tags = sortedTags(model);
  const operation = model.request?.operation._tag;
  const loadStatus =
    operation === "Load"
      ? model.index
        ? "Refreshing files…"
        : "Loading files…"
      : null;
  return workspace(
    {
      className: "tasks-workspace files-workspace",
      header: screenHeader(
        {
          title: "Files",
          navigation: model.selectedId
            ? [
                screenHeaderBack(
                  { href: filesPath, label: "Back to all files" },
                  h,
                ),
              ]
            : [],
          controls: [fileFilters(model, tags, h)],
          feedback: [
            visuallyHiddenStatus(loadStatus, h),
            h.p(
              [h.Role("status"), h.Class("workspace-header-progress")],
              operation === "Upload" ? ["Uploading file…"] : [],
            ),
            alert(
              {
                message: model.error,
                severity: "error",
                announcement: "status",
                action:
                  model.error &&
                  (!model.index || model.documentLoadFailed !== null)
                    ? button(
                        {
                          variant: "outline",
                          size: "sm",
                          onClick: Message.Retried(),
                          children: ["Retry"],
                        },
                        h,
                      )
                    : undefined,
              },
              h,
            ),
          ],
        },
        h,
      ),
      hasSelection: model.selectedId !== null,
      sheet: deleteFileDialog(model, h),
      list: fileList(model, tags, h),
      ...(model.selectedId ? { detail: fileDetail(model, tags, h) } : {}),
    },
    h,
  );
});
