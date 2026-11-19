import type { WorkerEnv } from "../../../../../alchemy.run.ts";
import { downloadWebsiteIcon, iconHostname } from "./website-icon.ts";

const iconPath = /^\/icons\/([a-z0-9.-]+)\/icon\.png$/iu;
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

export const bitwardenIcon = async (
  request: Request,
  url: URL,
  env: Pick<WorkerEnv, "APP_ORIGIN" | "BITWARDEN_ICON_LIMIT">,
  defer: (work: Promise<unknown>) => void,
) => {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" },
    });

  const [, requestedHost] = iconPath.exec(url.pathname) ?? [];
  const host = requestedHost && iconHostname(requestedHost);
  const blockedHosts = new Set([
    url.hostname,
    new URL(env.APP_ORIGIN).hostname,
  ]);
  if (!host || blockedHosts.has(host)) return missing();

  const key = new URL(`/icons/${host}/icon.png`, url.origin).href;
  const cache = await globalThis.caches
    ?.open("oneapp-website-icons")
    .catch(() => undefined);
  let icon = await cache?.match(key).catch(() => undefined);
  if (!icon) {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (!(await env.BITWARDEN_ICON_LIMIT.limit({ key: ip })).success)
      return new Response(null, {
        status: 429,
        headers: { "cache-control": "no-store" },
      });

    const image = await downloadWebsiteIcon(host, blockedHosts).catch(
      () => null,
    );
    icon = image
      ? new Response(image.body, {
          headers: {
            ...imageHeaders,
            "cache-control": `public, max-age=${iconTtl}`,
            "content-length": String(image.body.byteLength),
            "content-type": image.type,
          },
        })
      : missing(true);
    if (cache) defer(cache.put(key, icon.clone()).catch(() => undefined));
  }
  return request.method === "HEAD"
    ? new Response(null, { status: icon.status, headers: icon.headers })
    : icon;
};
