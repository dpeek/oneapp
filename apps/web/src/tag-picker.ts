import { Schema } from "effect";
import {
  normalizeTagName,
  TagName,
  tagNameKey,
  tagNameLimit,
  type Tag,
} from "./items-contract.ts";

export const createTagPrefix = "create:";

export const searchTags = (
  input: string,
  selectedIds: readonly string[],
  tags: readonly Tag[],
  error: string | null = null,
) => {
  const name = normalizeTagName(input);
  const key = tagNameKey(name);
  const matches = tags.filter((tag) => tagNameKey(tag.name).includes(key));
  const items = matches.filter((tag) => !selectedIds.includes(tag.id));
  const invalid = name !== "" && !Schema.is(TagName)(name);
  const canCreate =
    name !== "" &&
    !invalid &&
    !matches.some((tag) => tagNameKey(tag.name) === key);
  return {
    name,
    canCreate,
    items: canCreate
      ? [
          ...items,
          { id: `${createTagPrefix}${name}`, name: `Create “${name}”` },
        ]
      : items,
    error: invalid
      ? `Enter a tag name of up to ${tagNameLimit} characters.`
      : error,
  };
};
