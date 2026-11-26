import { resolve4, resolve6 } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { remoteImageUrl, trackingImageUrl } from "./mail-image-policy.ts";

export type RemoteImageResult =
  { status: "loaded"; source: string } | { status: "blocked" | "unavailable" };
export const mailImageLimit = 24;
const maxBytes = 1024 * 1024;
const maxDownloadBytes = 8 * 1024 * 1024;
const redirects = new Set([301, 302, 303, 307, 308]);
const publicAddress = (value: string) => {
  if (!ipaddr.isValid(value)) return false;
  const ip = ipaddr.parse(value);
  return (
    ip.range() === "unicast" &&
    (ip.kind() === "ipv4" || (ip.toByteArray()[0]! & 0xe0) === 0x20)
  );
};
const dnsRecords = (error: NodeJS.ErrnoException): string[] => {
  if (error.code === "ENODATA" || error.code === "ENOTFOUND") return [];
  throw error;
};
const rasterType = (bytes: Uint8Array) => {
  const has = (signature: number[]) =>
    signature.every((value, i) => bytes[i] === value);
  if (has([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (has([255, 216, 255])) return "image/jpeg";
  const header = new TextDecoder().decode(bytes.subarray(0, 12));
  if (/^GIF8[79]a/u.test(header)) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8) === "WEBP")
    return "image/webp";
  if (["ftypavif", "ftypavis"].includes(header.slice(4))) return "image/avif";
  return null;
};

// Called only after authenticating and reading a stored message. There is no
// arbitrary-URL proxy endpoint. Cache keys contain a digest, never email URLs.
export const loadMailImages = async (
  sources: readonly string[],
  origin: string,
  includeBlocked = false,
): Promise<Map<string, RemoteImageResult>> => {
  const blockedHosts = new Set([new URL(origin).hostname]);
  const signal = AbortSignal.timeout(8_000);
  const timedOut = new Promise<false>((resolve) =>
    signal.addEventListener("abort", () => resolve(false), { once: true }),
  );
  const dns = new Map<string, Promise<boolean>>();
  const cache = await globalThis.caches
    ?.open("oneapp-mail-images-v1")
    .catch(() => undefined);
  let remaining = maxDownloadBytes;
  const read = async (response: Response) => {
    if (
      !response.body ||
      Number(response.headers.get("content-length")) > maxBytes
    ) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body.getReader();
    const bytes = new Uint8Array(maxBytes);
    let length = 0;
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) return bytes.slice(0, length);
        remaining -= value.byteLength;
        if (remaining < 0 || length + value.byteLength > maxBytes) return null;
        bytes.set(value, length);
        length += value.byteLength;
      }
      return null;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  };
  const download = async (source: string) => {
    let target = remoteImageUrl(source, blockedHosts);
    for (
      let hop = 0;
      target && hop <= 2 && remaining > 0 && !signal.aborted;
      hop++
    ) {
      if (!includeBlocked && trackingImageUrl(target))
        return { status: "blocked" as const };
      let allowed = dns.get(target.hostname);
      if (!allowed) {
        allowed = Promise.all([
          resolve4(target.hostname).catch(dnsRecords),
          resolve6(target.hostname).catch(dnsRecords),
        ])
          .then(
            (records) =>
              records.flat().length > 0 && records.flat().every(publicAddress),
          )
          .catch(() => false);
        dns.set(target.hostname, allowed);
      }
      if (!(await Promise.race([allowed, timedOut])) || signal.aborted) break;
      // global_fetch_strictly_public protects the actual connection against
      // DNS rebinding after this check (also enabled for website icons).
      const response = await fetch(target, {
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal,
        headers: {
          accept: "image/png,image/jpeg,image/gif,image/webp,image/avif",
          "user-agent": "Orumai-Images/1.0",
        },
      });
      if (response.status === 200) {
        const bytes = await read(response);
        const type = bytes && rasterType(bytes);
        return bytes && type
          ? {
              status: "loaded" as const,
              source: `data:${type};base64,${bytes.toBase64()}`,
            }
          : { status: "unavailable" as const };
      }
      await response.body?.cancel();
      const location = response.headers.get("location");
      target =
        redirects.has(response.status) && location && location.length <= 4096
          ? remoteImageUrl(
              URL.parse(location, target)?.href ?? "",
              blockedHosts,
            )
          : null;
    }
    return { status: "unavailable" as const };
  };
  const results = new Map<string, RemoteImageResult>();
  let index = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (
        index < Math.min(sources.length, mailImageLimit) &&
        !signal.aborted
      ) {
        const source = sources[index++]!;
        try {
          // Keep override results separate: they may have followed a tracker redirect.
          const digest = new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(source),
            ),
          ).toHex();
          const key = `${origin}/__mail-image-cache/${includeBlocked ? "all" : "safe"}/${digest}`;
          let cached = await cache?.match(key).catch(() => undefined);
          if (!cached && includeBlocked) {
            // Reuse editorial images already fetched automatically; an override
            // must not generate another request for those recipient-specific URLs.
            const safe = await cache
              ?.match(`${origin}/__mail-image-cache/safe/${digest}`)
              .catch(() => undefined);
            if (safe && (await safe.clone().text()).startsWith("data:image/"))
              cached = safe;
          }
          let result: RemoteImageResult;
          if (cached) {
            const value = await cached.text();
            result =
              value === "blocked" || value === "unavailable"
                ? { status: value }
                : /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/u.test(
                      value,
                    ) && value.length < maxBytes * 1.4
                  ? { status: "loaded", source: value }
                  : { status: "unavailable" };
          } else {
            result = await download(source).catch(() => ({
              status: "unavailable" as const,
            }));
            if (cache && !signal.aborted)
              await cache
                .put(
                  key,
                  new Response(
                    result.status === "loaded" ? result.source : result.status,
                    {
                      headers: {
                        "cache-control": `public, max-age=${result.status === "loaded" ? 604800 : 3600}`,
                      },
                    },
                  ),
                )
                .catch(() => undefined);
          }
          results.set(source, result);
        } catch {
          results.set(source, { status: "unavailable" });
        }
      }
    }),
  );
  return results;
};
