import { workspacePath } from "@orumai/core";
import { FileMetadata } from "@orumai/core/files";
import { Schema } from "effect";
import { ItemId, ItemTagIds, Tag } from "./items-contract.ts";

export const filesPath = `${workspacePath}/files`;
export const filesApi = "/api/files";
export const filesChanged = "files.changed";
export const filePath = (id: string) => `${filesPath}/${id}`;
export const fileApi = (id: string) => `${filesApi}/${id}` as const;
export const fileDocumentsApi = `${filesApi}/documents`;
export const fileDocumentApi = (id: string) =>
  `${fileApi(id)}/document` as const;
export const fileImagesApi = (id: string) =>
  `${fileDocumentApi(id)}/images` as const;
export const fileImageApi = (id: string, imageId: string) =>
  `${fileImagesApi(id)}/${imageId}` as const;
export const fileContentApi = (id: string, action: "preview" | "download") =>
  `${fileApi(id)}/${action}` as const;

export const FileRoute = Schema.Struct({ id: Schema.NullOr(ItemId) });
export const fileRouteFor = (
  pathname: string,
): typeof FileRoute.Type | null => {
  const path = pathname.replace(/\/$/u, "");
  if (path === filesPath) return { id: null };
  if (!path.startsWith(`${filesPath}/`)) return null;
  const id = path.slice(filesPath.length + 1);
  return Schema.is(ItemId)(id) ? { id } : null;
};

export const fileUploadLimit = 16 * 1024 * 1024;
export const fileNameHeader = "x-oneapp-filename";
export const FileName = Schema.NonEmptyString.check(
  Schema.isMaxLength(255),
  Schema.isPattern(/^[^/\p{Cc}]+$/u),
);
export const FilePreviewType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);
export const StoredFile = Schema.Struct({
  ...FileMetadata.fields,
  id: ItemId,
  revision: ItemId,
  createdAt: Schema.Number,
  tagIds: ItemTagIds,
  previewType: Schema.NullOr(FilePreviewType),
  authored: Schema.Boolean,
});
export type StoredFile = typeof StoredFile.Type;
export const FileIndex = Schema.Struct({
  files: Schema.Array(StoredFile),
  tags: Schema.Array(Tag),
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const FileTagUpdate = Schema.Struct({
  revision: ItemId,
  tagIds: ItemTagIds,
});
export const FileDeletion = Schema.Struct({ revision: ItemId });
export const documentTitleLimit = 200;
export const documentMarkdownLimit = 20_000;
export const DocumentTitle = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(documentTitleLimit),
);
export const DocumentMarkdown = Schema.String.check(
  Schema.isMaxLength(documentMarkdownLimit),
);
export const FileDocument = Schema.Struct({
  file: StoredFile,
  markdown: DocumentMarkdown,
});
export type FileDocument = typeof FileDocument.Type;
export const FileDocumentCreate = Schema.Struct({
  id: Schema.optionalKey(ItemId),
  title: Schema.optionalKey(DocumentTitle),
  markdown: Schema.optionalKey(DocumentMarkdown),
  tagIds: Schema.optionalKey(ItemTagIds),
});
export const FileDocumentUpdate = Schema.Struct({
  revision: ItemId,
  title: DocumentTitle,
  markdown: DocumentMarkdown,
});
export const fileImageKey = (account: string, id: string, image: string) =>
  `document-images/${account}/${id}/${image}`;
