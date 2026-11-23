import { Schema } from "effect";

export const EditorBody = Schema.Struct({
  text: Schema.String,
  html: Schema.optionalKey(Schema.String),
});
export type EditorBody = typeof EditorBody.Type;

export const editorLink = (value: string) => {
  const href = value.trim();
  if (!/^(https?:\/\/|mailto:)/iu.test(href) || /[\p{Cc}]/u.test(href))
    return null;
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? href : null;
  } catch {
    return null;
  }
};
