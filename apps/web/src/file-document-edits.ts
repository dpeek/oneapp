import { Schema } from "effect";
import { FileDocument, type StoredFile } from "./files-contract.ts";
import { ItemId } from "./items-contract.ts";
import { InlineImageUploads } from "./markdown-editor-contract.ts";

export const Field = Schema.Literals(["title", "markdown"]);

export const Draft = Schema.Struct({
  saved: FileDocument,
  title: Schema.String,
  markdown: Schema.String,
  timer: Schema.NullOr(ItemId),
  queued: Schema.Boolean,
  uploads: InlineImageUploads,
  error: Schema.NullOr(Schema.String),
  latest: Schema.NullOr(FileDocument),
});
export type Draft = typeof Draft.Type;

export const init = (saved: FileDocument): Draft => ({
  saved,
  title: saved.file.name,
  markdown: saved.markdown,
  timer: null,
  queued: false,
  uploads: {},
  error: null,
  latest: null,
});

export const changed = (draft: Draft) =>
  draft.title.trim() !== draft.saved.file.name ||
  draft.markdown !== draft.saved.markdown;

export const uploading = (draft: Draft) =>
  Object.values(draft.uploads).some((value) => value instanceof File);

export const acceptSave = (draft: Draft, saved: FileDocument): Draft => ({
  ...draft,
  saved,
  error: null,
  latest: null,
});

export const retry = (draft: Draft): Draft => {
  const latest = draft.latest;
  if (!latest) return { ...draft, error: null, queued: true };
  return {
    ...acceptSave(draft, latest),
    title:
      draft.title.trim() === draft.saved.file.name
        ? latest.file.name
        : draft.title,
    markdown:
      draft.markdown === draft.saved.markdown
        ? latest.markdown
        : draft.markdown,
    queued: true,
  };
};

export const acceptTags = (
  draft: Draft,
  before: string,
  file: StoredFile,
): Draft =>
  draft.saved.file.revision === before
    ? { ...draft, saved: { ...draft.saved, file } }
    : draft;
