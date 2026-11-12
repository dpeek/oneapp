import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { SaveLink } from "./links.ts";

const decode = Schema.decodeUnknownSync(SaveLink);

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
