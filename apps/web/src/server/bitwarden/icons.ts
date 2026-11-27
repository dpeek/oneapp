import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import {
  companyWebsiteImagesPath,
  type CompanyWebsiteImages,
} from "../../company-avatar-contract.ts";
import { iconHostname, websiteIconPath } from "../../website-icon-host.ts";
import type { RenderCompanyAvatar } from "./company-avatar-image.ts";
import { discoverCompanyAvatars } from "./company-avatar.ts";
import type { RasterizeSvg } from "./website-icon-svg.ts";
import { downloadWebsiteIcon } from "./website-icon.ts";

const iconPath =
  /^\/icons\/([a-z0-9.-]+)\/(icon\.png|company\.jpg|company\.json)$/iu;
const iconTtl = 7 * 24 * 60 * 60;
const missingTtl = 60 * 60;
const imageHeaders = {
  "content-security-policy": "default-src 'none'; sandbox",
  "cross-origin-resource-policy": "cross-origin",
  "x-content-type-options": "nosniff",
};

const missing = (cacheable = false) =>
  new Response(null, {
    status: 404,
    headers: {
      ...imageHeaders,
      "cache-control": cacheable ? `public, max-age=${missingTtl}` : "no-store",
    },
  });

const imageResponse = (body: Uint8Array<ArrayBuffer>, type: string) =>
  new Response(body, {
    headers: {
      ...imageHeaders,
      "cache-control": `public, max-age=${iconTtl}`,
      "content-length": String(body.byteLength),
      "content-type": type,
    },
  });

export const bitwardenIcon = async (
  request: Request,
  url: URL,
  env: Pick<WorkerEnv, "APP_ORIGIN" | "BITWARDEN_ICON_LIMIT">,
  defer: (work: Promise<unknown>) => void,
  rasterizeSvg?: RasterizeSvg,
  renderCompanyAvatar?: RenderCompanyAvatar,
) => {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" },
    });

  const [, requestedHost, requestedAsset] = iconPath.exec(url.pathname) ?? [];
  const asset = requestedAsset?.toLowerCase();
  const host = requestedHost && iconHostname(requestedHost);
  const blockedHosts = new Set([
    url.hostname,
    new URL(env.APP_ORIGIN).hostname,
  ]);
  if (!host || blockedHosts.has(host)) return missing();

  const cache = await globalThis.caches
    ?.open("oneapp-website-icons")
    .catch(() => undefined);
  const cached = async (path: string, load: () => Promise<Response>) => {
    const key = new URL(path, url.origin).href;
    const hit = await cache?.match(key).catch(() => undefined);
    if (hit) return hit;

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (!(await env.BITWARDEN_ICON_LIMIT.limit({ key: ip })).success)
      return new Response(null, {
        status: 429,
        headers: { "cache-control": "no-store" },
      });

    const response = await load();
    if (cache) defer(cache.put(key, response.clone()).catch(() => undefined));
    return response;
  };
  const genericIcon = () =>
    cached(websiteIconPath(host), async () => {
      const image = await downloadWebsiteIcon(
        host,
        blockedHosts,
        rasterizeSvg,
      ).catch(() => null);
      return image ? imageResponse(image.body, image.type) : missing(true);
    });
  const companyIcon = async () => {
    const images = await cached(companyWebsiteImagesPath(host), async () => {
      const options = renderCompanyAvatar
        ? await discoverCompanyAvatars(
            host,
            blockedHosts,
            renderCompanyAvatar,
            rasterizeSvg,
          ).catch(() => [])
        : [];
      return Response.json(options, {
        headers: {
          ...imageHeaders,
          "cache-control": `public, max-age=${options.length ? iconTtl : missingTtl}`,
        },
      });
    });
    if (asset === "company.json" || !images.ok) return images;
    const [first] = (await images.json()) as CompanyWebsiteImages;
    if (!first) {
      const fallback = await genericIcon();
      if (!fallback.ok) return fallback;
      // Retry richer discovery on its normal schedule, even if the favicon is cached longer.
      const headers = new Headers(fallback.headers);
      headers.set("cache-control", `public, max-age=${missingTtl}`);
      return new Response(fallback.body, { headers });
    }
    return imageResponse(Uint8Array.fromBase64(first.photo), "image/jpeg");
  };
  const icon = await (asset === "icon.png" ? genericIcon() : companyIcon());
  if (request.method !== "HEAD") return icon;
  void icon.body?.cancel().catch(() => undefined);
  return new Response(null, { status: icon.status, headers: icon.headers });
};
