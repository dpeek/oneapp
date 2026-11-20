import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { normalizeLinkUrl, SaveLink } from "./links.ts";

const decode = Schema.decodeUnknownSync(SaveLink);

it.each([
  ["https://creaseui.com/", "https://creaseui.com"],
  ["http://example.com:8080/", "http://example.com:8080"],
  ["https://example.com", "https://example.com"],
  ["https://example.com/docs/", "https://example.com/docs/"],
  ["https://example.com//", "https://example.com//"],
  ["https://example.com/?q=value#part", "https://example.com/?q=value#part"],
  ["https://example.com/#part", "https://example.com/#part"],
])("normalizes %s to %s", (input, expected) => {
  expect(normalizeLinkUrl(input)).toBe(expected);
});

it("trims surrounding whitespace without changing the saved URL", () => {
  expect(decode({ url: " https://example.com/path?q=test#part " })).toEqual({
    url: "https://example.com/path?q=test#part",
  });
});

it.each([
  "javascript:alert(1)",
  "data:text/html,hello",
  "//example.com/relative",
  "https:example.com",
  "https://user:password@example.com/",
  "https://example.com/with spaces",
])("rejects unsafe or ambiguous link input %s", (url) => {
  expect(() => decode({ url })).toThrow();
});
