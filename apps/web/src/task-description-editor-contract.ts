import { Schema } from "effect";
import { CustomElement } from "foldkit";
import { ItemId } from "./items-contract.ts";
import {
  InlineImagePaste,
  InlineImageUploads,
} from "./task-attachment-contract.ts";

export const taskDescriptionEditor = CustomElement.define({
  tag: "orumai-task-description",
  properties: {
    value: Schema.String,
    readOnly: Schema.Boolean,
    taskId: Schema.NullOr(ItemId),
    taskRevision: Schema.NullOr(ItemId),
    inlineImageUploads: InlineImageUploads,
  },
  events: {
    "description-edited": Schema.String,
    "description-blurred": Schema.String,
    "description-image-pasted": InlineImagePaste,
  },
});
