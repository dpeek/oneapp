import { afterEach, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { mailImagePlaceholder } from "./mail-html.ts";
import { mailHtmlPreview } from "./mail-html-preview.ts";
import { loadMailImages, mailImageLimit } from "./mail-remote-images.ts";

const dns = vi.hoisted(() => ({ resolve4: vi.fn(), resolve6: vi.fn() }));
vi.mock("node:dns/promises", () => dns);
const origin = "https://app.example.net";
const png = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN9sAAAAASUVORK5CYII=",
);
const setup = () => {
  dns.resolve4.mockReset().mockResolvedValue(["1.1.1.1"]);
  dns.resolve6.mockReset().mockResolvedValue([]);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => new Response(png));
  const cache = new Map<string, Response>();
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("caches", {
    open: async () => ({
      match: async (key: string) => cache.get(key)?.clone(),
      put: async (key: string, response: Response) => {
        cache.set(key, response);
      },
    }),
  });
  return { fetch, cache };
};
afterEach(() => vi.unstubAllGlobals());

it("returns text/HTML immediately without fetching, then embeds cached editorial images", async () => {
  const { fetch, cache } = setup();
  const html =
    '<p>News</p><img src="https://cdn.example.com/photo.jpg?width=600&amp;token=abc" width="600"><img src="//cdn.example.com/photo.jpg?width=600&amp;token=abc">';
  const initial = await mailHtmlPreview(html, [], { origin });
  expect(initial.remoteImages).toMatchObject({
    available: 1,
    loaded: 0,
    blocked: 0,
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(initial.html.split(mailImagePlaceholder)).toHaveLength(3);
  const preview = await mailHtmlPreview(html, [], { origin, mode: "safe" });
  expect(preview.remoteImages).toMatchObject({ loaded: 1, unavailable: 0 });
  expect(preview.html.match(/src="data:image\/png/gu)).toHaveLength(2);
  expect(preview.html).not.toContain("cdn.example.com");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]![0])).toBe(
    "https://cdn.example.com/photo.jpg?width=600&token=abc",
  );
  expect(fetch.mock.calls[0]![1]).toMatchObject({
    credentials: "omit",
    redirect: "manual",
    cache: "no-store",
  });
  expect(Object.keys(fetch.mock.calls[0]![1]!.headers!)).toEqual([
    "accept",
    "user-agent",
  ]);
  expect([...cache.keys()][0]).not.toMatch(/photo|token=abc/u);
  expect(await mailHtmlPreview(html, [], { origin, mode: "safe" })).toEqual(
    preview,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("filters tiny, hidden, ancestor-hidden and known tracker images before DNS or HTTP", async () => {
  const { fetch } = setup();
  const html =
    '<img src="https://cdn.example.com/a" width="1" height="1"><img src="https://cdn.example.com/b" style="height:2px!important"><img src="https://cdn.example.com/c" hidden><div style="display: none"><span><img src="https://cdn.example.com/d"></span></div><img src="https://cdn.example.com/open.gif?id=123"><img src="https://cdn.example.com/wf/open?id=123">';
  const preview = await mailHtmlPreview(html, [], { origin, mode: "safe" });
  expect(preview.remoteImages).toMatchObject({ blocked: 6, loaded: 0 });
  expect(preview.html.split(mailImagePlaceholder)).toHaveLength(7);
  expect(fetch).not.toHaveBeenCalled();
  expect(dns.resolve4).not.toHaveBeenCalled();
  const allowed = await mailHtmlPreview(html, [], { origin, mode: "all" });
  expect(allowed.remoteImages).toMatchObject({ blocked: 0, loaded: 6 });
  expect(fetch).toHaveBeenCalledTimes(6);
  await mailHtmlPreview(html, [], { origin, mode: "safe" });
  expect(fetch).toHaveBeenCalledTimes(6);
});

it("does not fetch images discarded with active markup or beyond the nesting limit", async () => {
  const { fetch } = setup();
  const html =
    '<svg><image href="https://cdn.example.com/a"></svg><template><img src="https://cdn.example.com/b"></template><script><img src="https://cdn.example.com/c"></script>' +
    "<div>".repeat(60) +
    '<img src="https://cdn.example.com/deep">' +
    "</div>".repeat(60);
  await mailHtmlPreview(html, [], { origin, mode: "all" });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  "http://127.0.0.1/image",
  "http://2130706433/image",
  "https://[::1]/",
  "https://localhost/",
  "https://service.internal/",
  "https://app.example.net/private",
  "https://user:pass@cdn.example.com/a",
  "https://cdn.example.com:8443/a",
  "file:///tmp/image",
  "data:image/png;base64,aA==",
  "/api/account",
])("does not let the override fetch unsafe source %s", async (source) => {
  const { fetch } = setup();
  await mailHtmlPreview(`<img src="${source}">`, [], { origin, mode: "all" });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ["127.0.0.1"],
  ["169.254.169.254"],
  ["10.0.0.1", "1.1.1.1"],
  ["100.64.0.1"],
  ["192.0.2.1"],
])("rejects nonpublic or mixed DNS results %s", async (...records) => {
  const { fetch } = setup();
  dns.resolve4.mockResolvedValue(records);
  const preview = await mailHtmlPreview(
    '<img src="https://cdn.example.com/a">',
    [],
    { origin, mode: "all" },
  );
  expect(preview.remoteImages?.unavailable).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});

it("checks IPv6 and every redirect, including tracker patterns", async () => {
  const { fetch } = setup();
  dns.resolve6.mockResolvedValue(["::ffff:127.0.0.1"]);
  await loadMailImages(["https://cdn.example.com/a"], origin);
  expect(fetch).not.toHaveBeenCalled();
  dns.resolve6.mockResolvedValue([]);
  fetch.mockResolvedValueOnce(
    new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/metadata" },
    }),
  );
  expect(
    (await loadMailImages(["https://cdn.example.com/b"], origin, true)).get(
      "https://cdn.example.com/b",
    )?.status,
  ).toBe("unavailable");
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValueOnce(
    new Response(null, {
      status: 302,
      headers: { location: "/open.gif?recipient=123" },
    }),
  );
  const blocked = await mailHtmlPreview(
    '<img src="https://cdn.example.com/c">',
    [],
    { origin, mode: "safe" },
  );
  expect(blocked.remoteImages?.blocked).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  const allowed = await mailHtmlPreview(
    '<img src="https://cdn.example.com/c">',
    [],
    { origin, mode: "all" },
  );
  expect(allowed.remoteImages?.loaded).toBe(1);
});

it("caps redirects and rejects oversized, HTML and SVG bodies, caching failures", async () => {
  const { fetch } = setup();
  fetch.mockImplementation(
    async () =>
      new Response(null, { status: 302, headers: { location: "/loop" } }),
  );
  await loadMailImages(["https://cdn.example.com/loop"], origin);
  expect(fetch).toHaveBeenCalledTimes(3);
  for (const [name, body] of [
    ["html", "<script>evil()</script>"],
    ["svg", "<svg onload='evil()'></svg>"],
    ["large", new Uint8Array(1024 * 1024 + 1)],
  ] as const) {
    fetch.mockImplementation(
      async () =>
        new Response(body, { headers: { "content-type": "image/png" } }),
    );
    const url = `https://cdn.example.com/${name}`;
    expect((await loadMailImages([url], origin)).get(url)?.status).toBe(
      "unavailable",
    );
    const count = fetch.mock.calls.length;
    await loadMailImages([url], origin);
    expect(fetch).toHaveBeenCalledTimes(count);
  }
});

it("bounds image count and final HTML expansion, including repeated references", async () => {
  const { fetch } = setup();
  const image = new Uint8Array(900_000);
  image.set(png);
  fetch.mockImplementation(async () => new Response(image));
  const html = Array.from(
    { length: 60 },
    (_, i) => `<img src="https://cdn.example.com/${i}">`,
  ).join("");
  const result = await mailHtmlPreview(html, [], { origin, mode: "safe" });
  expect(fetch.mock.calls.length).toBeLessThanOrEqual(mailImageLimit);
  expect(result.html.length).toBeLessThan(5 * 1024 * 1024 + 5000);
  expect(result.remoteImages?.loaded).toBe(
    result.html.match(/src="data:image\/png/gu)?.length,
  );
  expect(result.remoteImages!.unavailable).toBeGreaterThan(0);
  const repeated = await mailHtmlPreview(
    '<img src="https://cdn.example.com/0">'.repeat(50),
    [],
    { origin, mode: "safe" },
  );
  expect(repeated.html.length).toBeLessThan(5 * 1024 * 1024 + 5000);
});

it("replaces unavailable remote images without masking the load status", async () => {
  const { fetch } = setup();
  fetch.mockImplementation(async () => new Response(null, { status: 404 }));
  const preview = await mailHtmlPreview(
    '<img src="https://cdn.example.com/missing" alt="Photo" width="300" height="150">',
    [],
    { origin, mode: "safe" },
  );
  expect(preview.html).toContain(mailImagePlaceholder);
  expect(preview.html).toContain("height:150px !important");
  expect(preview.remoteImages).toMatchObject({ loaded: 0, unavailable: 1 });
});
