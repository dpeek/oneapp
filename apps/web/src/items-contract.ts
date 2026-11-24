import { Schema } from "effect";

export const ItemId = Schema.String.check(Schema.isUUID(4));
export const itemTagLimit = 32;
export const ItemTagIds = Schema.Array(ItemId).check(
  Schema.isMaxLength(itemTagLimit),
);
export const tagsApi = "/api/tags";
export const tagNameLimit = 48;
export const TagName = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(tagNameLimit),
);
export const Tag = Schema.Struct({ id: ItemId, name: TagName });
export type Tag = typeof Tag.Type;
export const TagCreate = Schema.Struct({ name: TagName });
export const normalizeTagName = (name: string) => name.normalize("NFKC").trim();
export const tagNameKey = (name: string) =>
  normalizeTagName(name).toLowerCase();
