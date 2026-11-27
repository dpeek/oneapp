import { PhotonImage } from "@cf-wasm/photon/others";
import { afterEach, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import worker from "../worker.ts";
import {
  companyAvatarSize,
  companyAvatarPath,
  companyWebsiteImagesPath,
  type CompanyWebsiteImages,
} from "../../company-avatar-contract.ts";
import { createCompanyAvatarRenderer } from "./company-avatar-image.ts";
import { createSvgRasterizer } from "./website-icon-svg.ts";

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
const wasmFile = new URL(
  import.meta.resolve("@resvg/resvg-wasm/index_bg.wasm"),
);
const rasterizeSvg = createSvgRasterizer(
  await WebAssembly.compile(await Bun.file(wasmFile).arrayBuffer()),
);

const photonFile = new URL(import.meta.resolve("@cf-wasm/photon/photon.wasm"));
const renderCompanyAvatar = createCompanyAvatarRenderer(
  await WebAssembly.compile(await Bun.file(photonFile).arrayBuffer()),
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
    worker.fetch(
      new Request(appOrigin + path, init),
      env,
      undefined,
      rasterizeSvg,
      renderCompanyAvatar,
    );
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

it("renders a declared SVG favicon as a bounded PNG and caches it", async () => {
  const { request, fetch } = setup();
  fetch
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(
      new Response(
        '<head><link rel="icon" href="/logo.svg" type="image/svg+xml"></head>',
        {
          headers: { "content-type": "text/html" },
        },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 128"><rect width="32" height="128" fill="red"/></svg>',
        {
          headers: { "content-type": "image/svg+xml" },
        },
      ),
    );

  const icon = await request();
  expect(icon.status).toBe(200);
  expect(icon.headers.get("content-type")).toBe("image/png");
  const result = Buffer.from(await icon.arrayBuffer());
  expect(result.subarray(0, 8)).toEqual(png.subarray(0, 8));
  expect([result.readUInt32BE(16), result.readUInt32BE(20)]).toEqual([16, 64]);
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    "https://example.com/favicon.ico",
    "https://example.com/",
    "https://example.com/logo.svg",
  ]);
  expect(Buffer.from(await (await request()).arrayBuffer())).toEqual(result);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each([
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><image href="https://outside.example.com/icon.png" width="32" height="32"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32000 64000"><rect width="32000" height="64000"/></svg>',
  "<not-svg/>",
])(
  "continues looking for raster icons after an unusable SVG (%s)",
  async (svg) => {
    const { request, fetch } = setup();
    fetch
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          '<head><link rel="icon" href="/logo.svg"><link rel="icon" href="/logo.png"></head>',
          {
            headers: { "content-type": "text/html" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(svg, { headers: { "content-type": "image/svg+xml" } }),
      )
      .mockResolvedValueOnce(new Response(png));
    const icon = await request();
    expect(icon.status).toBe(200);
    expect(Buffer.from(await icon.arrayBuffer())).toEqual(png);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://example.com/favicon.ico",
      "https://example.com/",
      "https://example.com/logo.svg",
      "https://example.com/logo.png",
    ]);
  },
);

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

it("caches misses and rejects unrecognized and oversized images", async () => {
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

const fixtureIcon = async (size: number, markup: string) =>
  (await rasterizeSvg(
    new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${markup}</svg>`,
    ),
    size,
  ))!;

it("ranks decoded company artwork from HTML and manifests and keeps the generic favicon first", async () => {
  const { request, fetch, limit } = setup();
  const square = '<rect width="100" height="100" fill="navy"/>';
  const conventional = await fixtureIcon(16, square);
  const ico = new Uint8Array(22 + conventional.length);
  const header = new DataView(ico.buffer);
  header.setUint16(2, 1, true);
  header.setUint16(4, 1, true);
  header.setUint8(6, 16);
  header.setUint8(7, 16);
  header.setUint16(10, 1, true);
  header.setUint16(12, 32, true);
  header.setUint32(14, conventional.length, true);
  header.setUint32(18, 22, true);
  ico.set(conventional, 22);
  const assets = new Map([
    ["/favicon.ico", ico],
    ["/touch.png", await fixtureIcon(180, square.replace("navy", "green"))],
    ["/fake.png", await fixtureIcon(24, square.replace("navy", "orange"))],
    [
      "/manifest/large.png",
      await fixtureIcon(512, square.replace("navy", "purple")),
    ],
    [
      "/circle.png",
      await fixtureIcon(256, '<circle cx="50" cy="50" r="48" fill="red"/>'),
    ],
  ]);
  fetch.mockImplementation(async (input) => {
    const { pathname } = new URL(String(input));
    if (pathname === "/")
      return new Response(
        '<link rel="icon" sizes="1024x1024" href="/fake.png">' +
          '<link rel="apple-touch-icon" sizes="180x180" href="/touch.png">' +
          '<link rel="icon" sizes="256x256" href="/circle.png">' +
          '<link rel="manifest" href="/manifest/app.webmanifest">',
        { headers: { "content-type": "text/html" } },
      );
    if (pathname === "/manifest/app.webmanifest")
      return Response.json({
        icons: [
          { src: "large.png", sizes: "512x512", purpose: "maskable any" },
          { src: "https://127.0.0.1/private.png", sizes: "1024x1024" },
        ],
      });
    const body = assets.get(pathname);
    return body ? new Response(body) : new Response(null, { status: 404 });
  });

  const host = "example.com";
  const options = (await (
    await request(companyWebsiteImagesPath(host))
  ).json()) as CompanyWebsiteImages;
  expect(options.map(({ width }) => width)).toEqual([512, 256, 180, 24, 16]);
  const automatic = await request(companyAvatarPath(host));
  expect(automatic.headers.get("content-type")).toBe("image/jpeg");
  expect(new Uint8Array(await automatic.arrayBuffer()).toBase64()).toBe(
    options[0]!.photo,
  );
  expect(limit).toHaveBeenCalledOnce();
  expect(dns.resolve4.mock.calls).toEqual([[host]]);
  const generic = await request();
  expect(generic.headers.get("content-type")).toBe("image/x-icon");
  expect(new Uint8Array(await generic.arrayBuffer())).toEqual(ico);
});

it("keeps a transparent circular mark whole on a solid, high-density tile", async () => {
  const png = await fixtureIcon(
    512,
    '<circle cx="50" cy="50" r="35" fill="#e20000"/>',
  );
  const result = renderCompanyAvatar(png, "image/png");
  expect(result).toMatchObject({ width: 512, height: 512, shape: 1 });
  using tile = PhotonImage.new_from_byteslice(
    Uint8Array.fromBase64(result!.photo),
  );
  const size = companyAvatarSize;
  expect([tile.get_width(), tile.get_height()]).toEqual([size, size]);
  const pixels = tile.get_raw_pixels();
  const pixel = (x: number, y: number) =>
    Array.from(pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4));
  for (const [x, y] of [
    [0, 0],
    [size / 2, 0],
    [0, size / 2],
    [size - 1, size - 1],
  ] as const)
    expect(pixel(x, y)).toEqual([255, 255, 255, 255]);
  for (const [x, y] of [
    [size / 2, size / 2],
    [size / 2, 32],
    [32, size / 2],
  ] as const) {
    expect(pixel(x, y)[0]).toBeGreaterThan(200);
    expect(pixel(x, y)[1]).toBeLessThan(20);
  }
});

it("prefers a scalable declared icon over similarly shaped raster artwork", async () => {
  const { request, fetch } = setup();
  const large = await fixtureIcon(
    512,
    '<rect width="100" height="100" fill="navy"/>',
  );
  fetch
    .mockResolvedValueOnce(
      new Response(
        '<link rel="icon" sizes="512x512" href="/logo.png"><link rel="icon" sizes="any" href="/logo.svg">',
        { headers: { "content-type": "text/html" } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="green"/></svg>',
        { headers: { "content-type": "image/svg+xml" } },
      ),
    )
    .mockResolvedValueOnce(new Response(large));
  const response = await request(companyWebsiteImagesPath("example.com"));
  expect(await response.json()).toMatchObject([
    { scalable: true, width: companyAvatarSize, height: companyAvatarSize },
    { scalable: false, width: 512, height: 512 },
  ]);
});
