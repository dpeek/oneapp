import type { CompanyWebsiteImages } from "../../company-avatar-contract.ts";
import { companyAvatarSize } from "../../company-avatar-contract.ts";
import type { RenderCompanyAvatar } from "./company-avatar-image.ts";
import type { RasterizeSvg } from "./website-icon-svg.ts";
import {
  iconLinks,
  readBody,
  readWebsiteImage,
  siteFetcher,
} from "./website-icon.ts";

type Candidate = { url: URL; sizes: string; svg: boolean; maskable?: boolean };

const isSvg = (candidate: Candidate) =>
  candidate.svg || candidate.url.pathname.toLowerCase().endsWith(".svg");

const advertisedSize = (candidate: Candidate) => {
  if (isSvg(candidate) || /\bany\b/iu.test(candidate.sizes)) return 4096;
  let best = 0;
  for (const match of candidate.sizes.matchAll(/\b(\d{1,5})x(\d{1,5})\b/giu)) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    best = Math.max(best, Math.min(width, height));
  }
  return best;
};

const manifestIcons = async (
  fetchSite: ReturnType<typeof siteFetcher>,
  url: URL,
): Promise<Candidate[]> => {
  try {
    const result = await fetchSite(
      url,
      "application/manifest+json,application/json",
    );
    const bytes = result && (await readBody(result.response, 64 * 1024));
    if (!bytes) return [];
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
      icons?: unknown;
    };
    if (!Array.isArray(manifest?.icons)) return [];
    return manifest.icons.slice(0, 32).flatMap((entry: unknown) => {
      if (typeof entry !== "object" || !entry) return [];
      const icon = entry as Record<string, unknown>;
      if (typeof icon.src !== "string") return [];
      const url = URL.parse(icon.src, result.target);
      if (!url || url.protocol !== "https:") return [];
      return [
        {
          url,
          sizes: typeof icon.sizes === "string" ? icon.sizes : "",
          svg: icon.type === "image/svg+xml",
          maskable:
            typeof icon.purpose === "string" &&
            icon.purpose.toLowerCase().split(/\s+/u).includes("maskable"),
        },
      ];
    });
  } catch {
    return [];
  }
};

export const discoverCompanyAvatars = async (
  host: string,
  blockedHosts: ReadonlySet<string>,
  render: RenderCompanyAvatar,
  rasterizeSvg?: RasterizeSvg,
): Promise<CompanyWebsiteImages> => {
  const homepage = new URL(`https://${host}`);
  const fetchSite = siteFetcher(blockedHosts);
  const page = await fetchSite(homepage, "text/html,application/xhtml+xml");
  const location = page?.target ?? homepage;
  const links = page
    ? await iconLinks(
        page.response,
        location,
        Boolean(rasterizeSvg),
        true,
      ).catch(() => null)
    : null;
  const declared: Candidate[] = [
    ...(links?.icons ?? []),
    ...(links?.manifest ? await manifestIcons(fetchSite, links.manifest) : []),
  ].sort((a, b) => advertisedSize(b) - advertisedSize(a));
  const unique = new Map<string, Candidate>();
  for (const candidate of declared) {
    candidate.url.hash = "";
    const previous = unique.get(candidate.url.href);
    if (!previous) unique.set(candidate.url.href, candidate);
    else if (candidate.maskable) previous.maskable = true;
  }
  const fallback = [
    new URL("/favicon.ico", homepage),
    new URL("/favicon.ico", location),
    new URL("/apple-touch-icon.png", location),
  ];
  const candidates = new Map(Array.from(unique).slice(0, 6));
  for (const url of fallback)
    if (!candidates.has(url.href))
      candidates.set(url.href, { url, sizes: "", svg: false });

  const ranked = [];
  for (const { url, maskable } of candidates.values()) {
    const image = await readWebsiteImage(
      fetchSite,
      url,
      rasterizeSvg,
      companyAvatarSize,
    ).catch(() => null);
    if (!image) continue;
    const artwork = render(image.body, image.type);
    if (!artwork) continue;
    const { width, height, coverage, shape, photo } = artwork;
    // Size hints only decide what to fetch. Rank the artwork we actually decoded.
    const quality =
      (shape >= 0.87 ? 4 : shape >= 0.7 ? 2 : 0) +
      Number(coverage >= 0.55) +
      Number(image.scalable || Math.min(width, height) >= 48);
    ranked.push({
      quality,
      maskable: Number(Boolean(maskable)),
      image: { width, height, scalable: image.scalable, photo },
    });
  }
  ranked.sort(
    (a, b) =>
      b.quality - a.quality ||
      Number(b.image.scalable) - Number(a.image.scalable) ||
      Math.min(b.image.width, b.image.height) -
        Math.min(a.image.width, a.image.height) ||
      b.maskable - a.maskable,
  );
  const seen = new Set<string>();
  return ranked
    .flatMap(({ image }) => {
      if (seen.has(image.photo)) return [];
      seen.add(image.photo);
      return [image];
    })
    .slice(0, 5);
};
