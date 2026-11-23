import { iconHostname } from "../website-icon-host.ts";

// Deliberately narrow: image CDNs commonly use query strings and recipient-
// specific paths, so neither is enough on its own to classify an image.
export const trackingImageUrl = (url: URL) =>
  /(?:^|\.)(?:google-analytics\.com|doubleclick\.net)$/iu.test(url.hostname) ||
  /\/(?:open|track|tracking|pixel|beacon)(?:\.(?:gif|png|jpe?g|php|aspx?))?(?:\/|$)/iu.test(
    url.pathname,
  ) ||
  /\/wf\/open(?:\/|$)|\/q\/[^/]+\/o\.gif$|\/e\/o(?:\/|$)/iu.test(url.pathname);

export const remoteImageUrl = (
  source: string,
  blockedHosts: ReadonlySet<string> = new Set(),
) => {
  if (source.length > 4096) return null;
  const url = URL.parse(source.startsWith("//") ? `https:${source}` : source);
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  )
    return null;
  const host = iconHostname(url.hostname);
  if (!host || blockedHosts.has(host)) return null;
  url.hostname = host;
  url.hash = "";
  return url;
};

export const hiddenMailElement = (attrs: Record<string, string>) => {
  if ("hidden" in attrs) return true;
  const style = (attrs.style ?? "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .toLowerCase();
  return style.split(";").some((declaration) => {
    const [property, raw] = declaration.split(":");
    const value = raw?.replace(/\s*!important\s*$/u, "").trim();
    return (
      (property?.trim() === "display" && value === "none") ||
      (property?.trim() === "visibility" &&
        ["hidden", "collapse"].includes(value ?? "")) ||
      (property?.trim() === "mso-hide" && value === "all") ||
      (["opacity", "max-height", "max-width", "height", "width"].includes(
        property?.trim() ?? "",
      ) &&
        /^0(?:\.0+)?(?:px|em|rem|%)?$/u.test(value ?? ""))
    );
  });
};

export const tinyMailImage = (attrs: Record<string, string>) => {
  const dimensions = [attrs.width, attrs.height];
  for (const match of (attrs.style ?? "").matchAll(
    /(?:^|;)\s*(?:width|height|max-width|max-height)\s*:\s*([^;]+)/giu,
  ))
    dimensions.push(match[1]);
  return dimensions.some((value) => {
    const match = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*(?:!important\s*)?$/iu.exec(
      value ?? "",
    );
    return match !== null && Number(match[1]) <= 2;
  });
};
