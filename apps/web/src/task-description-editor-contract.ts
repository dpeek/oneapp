import { Schema } from "effect";
import { CustomElement } from "foldkit";

export const taskDescriptionEditor = CustomElement.define({
  tag: "orumai-task-description",
  properties: {
    value: Schema.String,
    readOnly: Schema.Boolean,
  },
  events: {
    "description-edited": Schema.String,
    "description-blurred": Schema.String,
  },
});
