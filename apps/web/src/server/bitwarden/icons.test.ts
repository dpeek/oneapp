import { afterEach, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import worker from "../worker.ts";

const dns = vi.hoisted(() => ({
  resolve4: vi.fn<(host: string) => Promise<string[]>>(),
  resolve6: vi.fn<(host: string) => Promise<string[]>>(),
}));
vi.mock("node:dns/promises", () => dns);

const appOrigin = "https://oneapp.example";
const iconPath = "/icons/example.com/icon.png";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX8sAAAAASUVORK5CYII=",
  "base64",
);

const setup = (success = true) => {
  const cache = new Map<string, Response>();
  const fetch = vi.fn<typeof globalThis.fetch>();
  fetch.mockImplementation(async () => new Response(null, { status: 404 }));
  dns.resolve4.mockReset().mockResolvedValue(["1.1.1.1"]);
  dns.resolve6.mockReset().mockResolvedValue([]);
  const limit = vi.fn(async () => ({ success }));
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("caches", {
    open: async () => ({
      match: async (key: string) => cache.get(key)?.clone(),
      put: async (key: string, response: Response) => {
        cache.set(key, response);
      },
    }),
  });
  const env = {
    APP_ORIGIN: appOrigin,
    BITWARDEN_ICON_LIMIT: { limit },
  } as unknown as WorkerEnv;
  const request = (path = iconPath, init?: RequestInit) =>
    worker.fetch(new Request(appOrigin + path, init), env);
  return { request, fetch, limit };
};

afterEach(() => vi.unstubAllGlobals());

it("downloads and caches a site's favicon without forwarding credentials", async () => {
  const { request, fetch, limit } = setup();
  fetch.mockResolvedValueOnce(
    new Response(png, {
      headers: {
        "content-type": "application/octet-stream",
        "set-cookie": "fixture=example",
      },
    }),
  );
  const first = await request("/icons/EXAMPLE.COM/icon.png?ignored=true", {
    headers: {
      cookie: "fixture=example",
      authorization: "Bearer fixture",
      "CF-Connecting-IP": "192.0.2.1",
    },
  });
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe("image/png");
  expect(first.headers.get("x-content-type-options")).toBe("nosniff");
  expect(first.headers.has("set-cookie")).toBe(false);
  expect(Buffer.from(await first.arrayBuffer())).toEqual(png);
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0]!;
  expect(String(url)).toBe("https://example.com/favicon.ico");
  expect(init).toMatchObject({ credentials: "omit", redirect: "manual" });
  const sent = new Headers(init?.headers);
  expect(sent.has("cookie") || sent.has("authorization")).toBe(false);
  expect(limit).toHaveBeenCalledWith({ key: "192.0.2.1" });

  const head = await request(undefined, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(String(png.length));
  expect(head.body).toBeNull();
  expect(fetch).toHaveBeenCalledOnce();
  expect(limit).toHaveBeenCalledOnce();
  expect(dns.resolve4).toHaveBeenCalledOnce();
});

it("discovers relative icon links from the redirected homepage", async () => {
  const { request, fetch } = setup();
  fetch
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://www.example.com/landing" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        '<head><base href="/brand/"><link rel="shortcut icon" href="logo.png?size=32&amp;v=2"></head>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
    )
    .mockResolvedValueOnce(new Response(png));
  const icon = await request();
  expect(icon.status).toBe(200);
  expect(Buffer.from(await icon.arrayBuffer())).toEqual(png);
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    "https://example.com/favicon.ico",
    "https://example.com/",
    "https://www.example.com/landing",
    "https://www.example.com/brand/logo.png?size=32&v=2",
  ]);
  expect(dns.resolve4.mock.calls).toEqual([
    ["example.com"],
    ["www.example.com"],
  ]);
});

it("blocks invalid hosts, non-public DNS and unsafe redirect and link targets", async () => {
  const { request, fetch } = setup();
  for (const host of [
    "127.0.0.1",
    "localhost",
    "router.home.arpa",
    "private.test",
    "bad..example.com",
    "example.com%2f..",
    "example.com:8443",
    "a-.example.com",
  ]) {
    expect((await request(`/icons/${host}/icon.png`)).status).toBe(404);
  }
  expect((await request(undefined, { method: "POST" })).status).toBe(405);
  expect(dns.resolve4).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();

  dns.resolve4.mockImplementation(async (host) =>
    host === "private.example.com" ? ["10.1.2.3"] : ["1.1.1.1"],
  );
  dns.resolve6.mockImplementation(async (host) =>
    host === "mixed.example.com" ? ["fc00::10"] : [],
  );
  expect((await request("/icons/mixed.example.com/icon.png")).status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
  fetch
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://private.example.com/icon.png" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        '<head><link rel="icon" href="https://127.0.0.1/icon.png"><link rel="icon" href="http://example.com/icon.png"><link rel="icon" href="https://mixed.example.com/icon.png"></head>',
        { headers: { "content-type": "text/html" } },
      ),
    );
  expect((await request()).status).toBe(404);
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    "https://example.com/favicon.ico",
    "https://example.com/",
    "https://example.com/apple-touch-icon.png",
  ]);
});

it("caches misses and rejects SVG and oversized images", async () => {
  const { request, fetch } = setup();
  const oversized = new Uint8Array(512 * 1024 + 1);
  oversized.set(png);
  fetch
    .mockResolvedValueOnce(
      new Response(oversized, { headers: { "content-type": "image/png" } }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(
      new Response("<svg></svg>", { headers: { "content-type": "image/png" } }),
    );
  const miss = await request();
  expect(miss.status).toBe(404);
  expect(miss.headers.get("cache-control")).toBe("public, max-age=3600");
  expect((await request()).status).toBe(404);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("rate limits cache misses before contacting DNS or websites", async () => {
  const { request, fetch } = setup(false);
  expect((await request()).status).toBe(429);
  expect(dns.resolve4).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
