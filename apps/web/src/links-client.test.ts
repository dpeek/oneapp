import { expect, it } from "@effect/vitest";
import { parseLinkInput, webLinkHref } from "./links-client.ts";

it.each([
  [" example.com/path?q=one#two ", "https://example.com/path?q=one#two"],
  ["example.com:8443", "https://example.com:8443"],
  ["example.com/", "https://example.com"],
  ["https://example.com/docs/", "https://example.com/docs/"],
  ["//example.com/path", "https://example.com/path"],
  ["localhost:3000", "https://localhost:3000"],
  ["127.0.0.1:8080", "https://127.0.0.1:8080"],
  ["[::1]:8080", "https://[::1]:8080"],
  ["http://example.com/path", "http://example.com/path"],
  ["HTTPS://example.com", "HTTPS://example.com"],
])("parses %s as %s", (input, url) => {
  expect(parseLinkInput(input)).toEqual({ url });
});

it.each([
  "",
  "example",
  "/example.com/path",
  "example.com/with spaces",
  "example.com:65536",
  "user:password@example.com",
  "https://user:password@example.com",
  "ftp://example.com",
  "javascript:alert(1)",
])("rejects %j", (input) => {
  expect(parseLinkInput(input)).toBeNull();
});

it.each([
  [
    "example.com:8443/settings#account",
    "https://example.com:8443/settings#account",
  ],
  ["http://localhost:8080/login", "http://localhost:8080/login"],
  [
    `https://example.com/${"a".repeat(2048)}`,
    `https://example.com/${"a".repeat(2048)}`,
  ],
])("opens saved web address %s", (input, href) => {
  expect(webLinkHref(input)).toBe(href);
});

it.each([
  "androidapp://com.example.app",
  "javascript:alert(1)",
  "data:text/html,example",
  "https://user:password@example.com",
])("does not open stored URI %s", (input) => {
  expect(webLinkHref(input)).toBeUndefined();
});
