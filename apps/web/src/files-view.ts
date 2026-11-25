import {
  alert,
  button,
  buttonClassName,
  empty,
  filesIconPaths,
  input,
  item,
  itemGroup,
  outlineIcon,
  plusIcon,
  skeleton,
  Tokenizer,
  visuallyHiddenStatus,
} from "@oneapp/ui";
import { Effect } from "effect";
import { Mount, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { fileSize, renderPdf } from "./file-display.ts";
import { filterChoice, filterMenu } from "./filter-menu.ts";
import {
  fileContentApi,
  filePath,
  filesPath,
  fileUploadLimit,
  type StoredFile,
} from "./files-contract.ts";
import {
  filterOptionsId,
  Message,
  selectedFile,
  toFilterPopoverMessage,
  uploadInputId,
  type Model,
} from "./files.ts";
import {
  ItemId,
  itemTagLimit,
  tagNameLimit,
  type Tag,
} from "./items-contract.ts";
import { searchTags } from "./tag-picker.ts";
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

const downloadLink = (file: StoredFile, h: HtmlBuilder<Message>) =>
  h.a(
    [
      h.Href(fileContentApi(file.id, "download")),
      h.Download(file.name),
      h.Class(buttonClassName({ variant: "outline", size: "sm" })),
      h.DataAttribute("slot", "button"),
    ],
    [outlineIcon(h, ["M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"]), "Download"],
  );

const fileDetail = (
  model: Model,
  tags: readonly Tag[],
  h: HtmlBuilder<Message>,
) => {
  const file = selectedFile(model);
  const id = model.selectedId;
  const detail = () => {
    if (!file)
      return h.p(model.error || model.request ? [] : [h.Role("status")], [
        model.request
          ? "Loading file…"
          : model.index
            ? "File not found."
            : "File details are unavailable.",
      ]);
    const full = file.tagIds.length >= itemTagLimit;
    const search = searchTags(model.tagPicker.inputValue, file.tagIds, tags);
    return h.div(
      [h.Key(file.id), h.Class("file-detail-content")],
      [
        h.div(
          [h.Class("file-detail-heading")],
          [h.h2([], [file.name]), downloadLink(file, h)],
        ),
        h.dl(
          [h.Class("file-properties")],
          [
            h.div([], [h.dt([], ["Media type"]), h.dd([], [file.mediaType])]),
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
        Tokenizer.view(
          {
            model: model.tagPicker,
            label: "Tags",
            placeholder: "Search or create tags",
            emptyMessage: "No matching tags",
            items: search.items,
            selected: tags.filter(({ id }) => file.tagIds.includes(id)),
            maxLength: tagNameLimit,
            busy: model.request !== null,
            full,
            description: full
              ? `A file can have up to ${itemTagLimit} tags.`
              : null,
            error: search.error,
            toParentMessage: (message) =>
              Message.GotTagPickerMessage({ id: file.id, message }),
            onRemove: (id) => Message.RemovedTag({ id }),
          },
          h,
        ),
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

const fileList = (
  model: Model,
  tags: readonly Tag[],
  h: HtmlBuilder<Message>,
) => {
  const files = (model.index?.files ?? []).filter(
    ({ tagIds }) => !model.tagFilter || tagIds.includes(model.tagFilter),
  );
  const tagMap = new Map(tags.map((tag) => [tag.id, tag.name]));
  const hasFiles = !!model.index?.files.length;
  const emptyTitle =
    !model.index || files.length
      ? null
      : hasFiles
        ? "No files match this tag"
        : "No files uploaded";
  return h.section(
    [h.Class("workspace-list file-list"), h.AriaLabel("File list")],
    [
      visuallyHiddenStatus(emptyTitle, h),
      h.div(
        [h.Class("workspace-results")],
        files.length
          ? [
              itemGroup(
                files.map((file) =>
                  item(
                    {
                      key: file.id,
                      href: filePath(file.id),
                      title: file.name,
                      linkAttributes:
                        model.selectedId === file.id
                          ? [h.AriaCurrent("page")]
                          : [],
                      description: h.div(
                        [h.Class("file-row-metadata")],
                        [
                          h.span([], [fileSize(file.size)]),
                          ...file.tagIds.flatMap((id) => {
                            const name = tagMap.get(id);
                            return name
                              ? [
                                  h.span(
                                    [h.Key(id), h.Class("task-tag")],
                                    [name],
                                  ),
                                ]
                              : [];
                          }),
                        ],
                      ),
                    },
                    h,
                  ),
                ),
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

const uploadControl = (model: Model, h: HtmlBuilder<Message>) =>
  h.label(
    [h.Class("file-upload")],
    [
      h.span(
        [
          h.Class(buttonClassName({ size: "sm", rounded: true })),
          h.DataAttribute("slot", "button"),
          h.AriaHidden(true),
        ],
        [plusIcon(h, "16"), "File"],
      ),
      input<Message>(
        [
          h.Type("file"),
          h.Id(uploadInputId),
          h.AriaLabel("Upload file"),
          h.Disabled(model.request !== null || model.index === null),
          h.OnChange((value) =>
            Message.PickedFile({ source: "header", selected: value !== "" }),
          ),
        ],
        h,
      ),
    ],
  );

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const tags = [...(model.index?.tags ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
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
          primaryAction: uploadControl(model, h),
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
                  model.error && !model.index
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
      list: fileList(model, tags, h),
      ...(model.selectedId ? { detail: fileDetail(model, tags, h) } : {}),
    },
    h,
  );
});
