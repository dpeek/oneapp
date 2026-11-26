import { Schema } from "effect";
import { CustomElement } from "foldkit";
import { EditorBody } from "./mail-format.ts";
export { EditorBody } from "./mail-format.ts";

export const mailEditor = CustomElement.define({
  tag: "orumai-mail-editor",
  properties: {
    value: EditorBody,
    readOnly: Schema.Boolean,
    label: Schema.String,
    compact: Schema.Boolean,
  },
  events: { "body-edited": EditorBody },
});
