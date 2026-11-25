import {
  alert,
  backIcon,
  button,
  buttonClassName,
  empty,
  filesIconPaths,
  input,
  nativeSelect,
  outlineIcon,
  skeleton,
  Tokenizer,
  visuallyHiddenStatus,
} from "@oneapp/ui";
import { Effect } from "effect";
import { Mount, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { fileSize, renderPdf } from "./file-display.ts";
import {
  fileContentApi,
  filePath,
  filesPath,
  fileUploadLimit,
  type StoredFile,
} from "./files-contract.ts";
import { Message, selectedFile, uploadInputId, type Model } from "./files.ts";
import {
  ItemId,
  itemTagLimit,
  tagNameLimit,
  type Tag,
} from "./items-contract.ts";
import { searchTags } from "./tag-picker.ts";
import { workspace } from "./workspace.ts";

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
    [
      h.a(
        [h.Class("task-back"), h.Href(filesPath)],
        [backIcon(h), "All files"],
      ),
      detail(),
    ],
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

const fileList = (
  model: Model,
  tags: readonly Tag[],
  upload: Html | undefined,
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
    [h.Class("workspace-list task-list"), h.AriaLabel("File list")],
    [
      h.div(
        [h.Class("task-list-toolbar task-list-filters")],
        [
          nativeSelect(
            {
              label: "Tag filter",
              value: model.tagFilter ?? "",
              options: [
                { value: "", label: "All tags" },
                ...tags.map(({ id, name }) => ({
                  value: id,
                  label: name,
                })),
              ],
              onChange: (value) => Message.SetTagFilter({ value }),
            },
            h,
          ),
        ],
      ),
      visuallyHiddenStatus(emptyTitle, h),
      h.div(
        [h.Class("workspace-results")],
        files.length
          ? [
              h.ul(
                [h.Class("task-rows")],
                files.map((file) => {
                  const selected = model.selectedId === file.id;
                  return h.li(
                    [
                      h.Key(file.id),
                      h.Class("task-row file-row"),
                      h.DataAttribute("selected", String(selected)),
                    ],
                    [
                      h.a(
                        [
                          h.Class("task-row-link"),
                          h.Href(filePath(file.id)),
                          ...(selected ? [h.AriaCurrent("page")] : []),
                        ],
                        [
                          h.span(
                            [h.Class("task-row-main")],
                            [
                              h.span([h.Class("task-row-title")], [file.name]),
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
                          h.span(
                            [h.Class("task-row-properties")],
                            [fileSize(file.size)],
                          ),
                        ],
                      ),
                    ],
                  );
                }),
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
                      : upload,
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
          h.Class(buttonClassName({ size: "sm" })),
          h.DataAttribute("slot", "button"),
        ],
        [
          model.request?.operation._tag === "Upload"
            ? "Uploading…"
            : "Upload file",
        ],
      ),
      input(
        [
          h.Type("file"),
          h.Id(uploadInputId),
          h.AriaLabel("Upload file"),
          h.Disabled(model.request !== null || model.index === null),
          h.OnChange(() => Message.PickedFile()),
        ],
        h,
      ),
    ],
  );

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const tags = [...(model.index?.tags ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const upload = uploadControl(model, h);
  const uploadInEmpty =
    model.selectedId === null && model.index?.files.length === 0;
  const operation = model.request?.operation._tag;
  const loadStatus =
    operation === "Load"
      ? model.index
        ? "Refreshing files…"
        : "Loading files…"
      : operation === "Upload"
        ? "Uploading file…"
        : null;
  return workspace(
    {
      className: "tasks-workspace files-workspace",
      title: "Files",
      headerAttributes: [h.Tabindex(-1)],
      headerActions: [
        ...(!uploadInEmpty ? [upload] : []),
        visuallyHiddenStatus(loadStatus, h),
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
      hasSelection: model.selectedId !== null,
      list: fileList(model, tags, uploadInEmpty ? upload : undefined, h),
      ...(model.selectedId ? { detail: fileDetail(model, tags, h) } : {}),
    },
    h,
  );
});
