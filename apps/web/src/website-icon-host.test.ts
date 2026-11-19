import { expect, it } from "@effect/vitest";
import { websiteIconHostname, websiteIconPath } from "./website-icon-host.ts";

it("builds a same-origin icon path from the hostname alone", () => {
  const hostname = websiteIconHostname(
    "https://user:password@EXAMPLE.com.:8888/private?token=secret#login",
  );
  expect(hostname).toBe("example.com");
  expect(websiteIconPath(hostname!)).toBe("/icons/example.com/icon.png");
  expect(websiteIconHostname("http://bücher.example.com/")).toBe(
    "xn--bcher-kva.example.com",
  );
  expect(websiteIconHostname("EXAMPLE.com/portal?token=secret")).toBe(
    "example.com",
  );
});

it("skips app URIs, IP addresses, and reserved or local hostnames", () => {
  for (const uri of [
    "androidapp://com.example.app",
    "javascript:alert(1)",
    "https://127.0.0.1",
    "https://[::1]",
    "https://intranet",
    "https://example.local",
    "test-user@example.com",
    "not a URL",
  ])
    expect(websiteIconHostname(uri)).toBeNull();
});
