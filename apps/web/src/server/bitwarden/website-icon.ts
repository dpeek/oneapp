import { resolve4, resolve6 } from "node:dns/promises";
import { decodeHTMLAttribute } from "entities";
import ipaddr from "ipaddr.js";

import { iconHostname } from "../../website-icon-host.ts";
import type { RasterizeSvg } from "./website-icon-svg.ts";

const isPublicAddress = (value: string) => {
  if (!ipaddr.isValid(value)) return false;
  const address = ipaddr.parse(value);
  return (
    address.range() === "unicast" &&
    (address.kind() === "ipv4" || (address.toByteArray()[0]! & 0xe0) === 0x20)
  );
};

const addressRecords = (error: NodeJS.ErrnoException): string[] => {
  if (error.code === "ENODATA" || error.code === "ENOTFOUND") return [];
  throw error;
};

const resolvesPublicly = async (host: string) => {
  const records = await Promise.all([
    resolve4(host).catch(addressRecords),
    resolve6(host).catch(addressRecords),
  ]);
  const addresses = records.flat();
  return addresses.length > 0 && addresses.every(isPublicAddress);
};

const redirects = new Set([301, 302, 303, 307, 308]);
const maxRedirects = 2;
const maxRequests = 12;
const maxIconBytes = 512 * 1024;
const maxHtmlBytes = 256 * 1024;
const acceptImage =
  "image/png,image/x-icon,image/vnd.microsoft.icon,image/webp,image/jpeg,image/gif,image/avif";

const siteFetcher = (blockedHosts: ReadonlySet<string>) => {
  const dns = new Map<string, Promise<boolean>>();
  const signal = AbortSignal.timeout(6_000);
  const timedOut = new Promise<false>((resolve) => {
    signal.addEventListener("abort", () => resolve(false), { once: true });
  });
  let requests = 0;

  return async (start: URL, accept: string) => {
    let target = start;
    for (let hop = 0; hop <= maxRedirects && requests < maxRequests; hop++) {
      const host = iconHostname(target.hostname);
      if (
        signal.aborted ||
        !host ||
        blockedHosts.has(host) ||
        target.protocol !== "https:" ||
        target.href.length > 4096 ||
        target.port ||
        target.username ||
        target.password
      )
        return null;

      let allowed = dns.get(host);
      if (!allowed) {
        allowed = resolvesPublicly(host).catch(() => false);
        dns.set(host, allowed);
      }
      if (!(await Promise.race([allowed, timedOut])) || signal.aborted)
        return null;

      // The Worker uses global_fetch_strictly_public for the actual connection.
      target.hostname = host;
      target.hash = "";
      requests++;
      const response = await fetch(target, {
        credentials: "omit",
        redirect: "manual",
        cache: "no-store",
        headers: { accept },
        signal,
      }).catch(() => null);
      if (!response) return null;
      if (response.status === 200) return { target, response };
      await response.body?.cancel();
      const location = response.headers.get("location");
      const next =
        location &&
        location.length <= 4096 &&
        redirects.has(response.status) &&
        URL.parse(location, target);
      if (!next) return null;
      target = next;
    }
    return null;
  };
};

const readBody = async (response: Response, limit: number, prefix = false) => {
  const body = response.body;
  if (!body) return null;
  if (!prefix && Number(response.headers.get("content-length")) > limit) {
    await body.cancel();
    return null;
  }
  const reader = body.getReader();
  const bytes = new Uint8Array(limit);
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) return bytes.slice(0, length);
    const remaining = limit - length;
    if (!prefix && value.byteLength > remaining) {
      await reader.cancel();
      return null;
    }
    const chunk = value.subarray(0, remaining);
    bytes.set(chunk, length);
    length += chunk.byteLength;
    if (prefix && length === limit) {
      await reader.cancel();
      return bytes;
    }
  }
};

const matches = (
  bytes: Uint8Array,
  marker: readonly number[] | Uint8Array,
  from = 0,
) => marker.every((byte, index) => bytes[from + index] === byte);
const encoder = new TextEncoder();
const gif87a = encoder.encode("GIF87a");
const gif89a = encoder.encode("GIF89a");
const riff = encoder.encode("RIFF");
const webp = encoder.encode("WEBP");
const avif = encoder.encode("ftypavif");
const avis = encoder.encode("ftypavis");
const rasterType = (bytes: Uint8Array) => {
  if (matches(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (matches(bytes, [0, 0, 1, 0]) && bytes.length > 6) return "image/x-icon";
  if (matches(bytes, [255, 216, 255])) return "image/jpeg";
  if (matches(bytes, gif87a) || matches(bytes, gif89a)) return "image/gif";
  if (matches(bytes, riff) && matches(bytes, webp, 8)) return "image/webp";
  if (matches(bytes, avif, 4) || matches(bytes, avis, 4)) return "image/avif";
  return null;
};

const iconLinks = async (page: Response, url: URL, allowSvg: boolean) => {
  const type = page.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (type !== "text/html" && type !== "application/xhtml+xml") {
    await page.body?.cancel();
    return [];
  }
  const bytes = await readBody(page, maxHtmlBytes, true);
  if (!bytes) return [];

  let base: URL | null = null;
  const links: string[] = [];
  await new HTMLRewriter()
    .on("head base[href]", {
      element(element) {
        base ??= URL.parse(
          decodeHTMLAttribute(element.getAttribute("href")!),
          url,
        );
      },
    })
    .on("link[rel][href]", {
      element(element) {
        if (links.length >= 16) return;
        const rel =
          element.getAttribute("rel")?.toLowerCase().split(/\s+/u) ?? [];
        const href = element.getAttribute("href");
        if (
          href &&
          (allowSvg ||
            element.getAttribute("type")?.toLowerCase() !== "image/svg+xml") &&
          rel.some((part) =>
            [
              "icon",
              "apple-touch-icon",
              "apple-touch-icon-precomposed",
            ].includes(part),
          )
        )
          links.push(href);
      },
    })
    .transform(
      new Response(bytes, { headers: { "content-type": "text/html" } }),
    )
    .arrayBuffer();

  return links.flatMap((href) => {
    const target = URL.parse(decodeHTMLAttribute(href), base ?? url);
    return target?.protocol === "https:" ? [target] : [];
  });
};

export const downloadWebsiteIcon = async (
  host: string,
  blockedHosts: ReadonlySet<string>,
  rasterizeSvg?: RasterizeSvg,
) => {
  const homepage = new URL(`https://${host}`);
  const fetchSite = siteFetcher(blockedHosts);
  const readIcon = async (url: URL) => {
    const result = await fetchSite(
      url,
      rasterizeSvg ? `${acceptImage},image/svg+xml` : acceptImage,
    );
    if (!result) return null;
    const { response, target } = result;
    const body = await readBody(response, maxIconBytes);
    if (!body) return null;
    const type = rasterType(body);
    if (type) return { body, type };
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (
      rasterizeSvg &&
      (contentType === "image/svg+xml" ||
        url.pathname.toLowerCase().endsWith(".svg") ||
        target.pathname.toLowerCase().endsWith(".svg"))
    ) {
      const png = await rasterizeSvg(body);
      if (png) return { body: png, type: "image/png" };
    }
    return null;
  };

  const favicon = new URL("/favicon.ico", homepage);
  const conventionalIcon = await readIcon(favicon);
  if (conventionalIcon) return conventionalIcon;

  const page = await fetchSite(homepage, "text/html,application/xhtml+xml");
  const declared = page
    ? await iconLinks(page.response, page.target, Boolean(rasterizeSvg))
    : [];
  const location = page?.target ?? homepage;
  const candidates = [
    ...declared.slice(0, 3),
    new URL("/favicon.ico", location),
    new URL("/apple-touch-icon.png", location),
  ];
  const seen = new Set([favicon.href]);
  for (const candidate of candidates) {
    if (seen.has(candidate.href)) continue;
    seen.add(candidate.href);
    const icon = await readIcon(candidate);
    if (icon) return icon;
  }
  return null;
};
