import { expect, it } from "@effect/vitest";
import { httpsPage, matchesLoginUri } from "./vault-matching.ts";

it("matches only the same HTTPS origin, including scheme, host and port", () => {
  const page = new URL("https://login.example.test/inbox");
  expect(matchesLoginUri(page, "https://login.example.test/profile")).toBe(
    true,
  );
  expect(matchesLoginUri(page, "https://LOGIN.example.test:443", 0)).toBe(true);
  expect(matchesLoginUri(page, "https://example.test", 0)).toBe(false);
  expect(matchesLoginUri(page, "https://login.example.test:8443", 1)).toBe(
    false,
  );
  expect(matchesLoginUri(page, "http://login.example.test/", 1)).toBe(false);
  expect(matchesLoginUri(page, "https://login.example.test@other.test")).toBe(
    false,
  );
  expect(httpsPage("http://login.example.test/")).toBeNull();
  expect(httpsPage("chrome://settings/")).toBeNull();
  expect(httpsPage(undefined)).toBeNull();
});

it("preserves exact, prefix and never restrictions and skips regex patterns", () => {
  const page = new URL("https://example.test/login?account=1");
  expect(matchesLoginUri(page, "https://example.test/log", 2)).toBe(true);
  expect(matchesLoginUri(page, "https://example.test/other", 2)).toBe(false);
  expect(matchesLoginUri(page, "https://example.test/login", 3)).toBe(false);
  expect(matchesLoginUri(page, page.href, 3)).toBe(true);
  expect(matchesLoginUri(page, page.href, 5)).toBe(false);
  expect(matchesLoginUri(page, ".*", 4)).toBe(false);
});
