import { Schema } from "effect";
import { CustomElement } from "foldkit";
import { ItemId } from "./items-contract.ts";
export const InlineImagePaste = Schema.Struct({
  id: ItemId,
  file: Schema.instanceOf(File),
});
export const InlineImageUploads = Schema.Record(
  Schema.String,
  Schema.Union([Schema.Literal(true), Schema.String, Schema.instanceOf(File)]),
);

export const markdownEditor = CustomElement.define({
  tag: "orumai-markdown-editor",
  properties: {
    value: Schema.String,
    readOnly: Schema.Boolean,
    imageCollection: Schema.NullOr(Schema.String),
    label: Schema.String,
    placeholder: Schema.String,
    limit: Schema.Number,
    revision: Schema.NullOr(ItemId),
    inlineImageUploads: InlineImageUploads,
  },
  events: {
    "description-edited": Schema.String,
    "description-blurred": Schema.String,
    "description-image-pasted": InlineImagePaste,
  },
});
