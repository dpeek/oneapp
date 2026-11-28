import { Schema } from "effect";
import {
  itemTagLimit,
  normalizeTagName,
  TagName,
  tagNameKey,
  tagNameLimit,
  type Tag,
} from "./items-contract.ts";

export const createTagPrefix = "create:";
export const clearTagChoice = "clear";

export const tagChoices = (
  query: string,
  selected: readonly string[],
  tags: readonly Tag[],
  item: "task" | "file" | "document" = "task",
) => {
  const name = normalizeTagName(query);
  const key = tagNameKey(name);
  const matchingTags = tags.filter((tag) => tagNameKey(tag.name).includes(key));
  const atLimit = selected.length >= itemTagLimit;
  const choices = [
    ...matchingTags.filter(({ id }) => selected.includes(id)),
    ...matchingTags.filter(({ id }) => !selected.includes(id)),
  ].map((tag) => ({ ...tag, disabled: atLimit && !selected.includes(tag.id) }));
  const invalid = name !== "" && !Schema.is(TagName)(name);
  if (
    name &&
    !invalid &&
    !atLimit &&
    !matchingTags.some((tag) => tagNameKey(tag.name) === key)
  )
    choices.push({
      id: `${createTagPrefix}${name}`,
      name: `Create “${name}”`,
      disabled: false,
    });
  return {
    choices,
    error: invalid
      ? `Enter a tag name of up to ${tagNameLimit} characters.`
      : atLimit
        ? `Up to ${itemTagLimit} tags per ${item}.`
        : null,
  };
};
