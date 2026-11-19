import { Schema } from "effect";

export const FileMetadata = Schema.Struct({
  name: Schema.String,
  mediaType: Schema.String,
  size: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type FileMetadata = typeof FileMetadata.Type;
