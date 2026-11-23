import type { Attachment } from "postal-mime";
import { sanitizeMailHtml } from "./mail-html.ts";
import {
  remoteImageUrl,
  tinyMailImage,
  trackingImageUrl,
} from "./mail-image-policy.ts";
import { loadMailImages, mailImageLimit } from "./mail-remote-images.ts";

export type MailImageOptions = { origin: string; mode?: "safe" | "all" };

export const mailHtmlPreview = async (
  html: string,
  attachments: readonly Attachment[],
  options?: MailImageOptions,
) => {
  if (!options) return { html: sanitizeMailHtml(html, attachments) };
  const blockedHosts = new Set([new URL(options.origin).hostname]);
  const candidates = new Map<string, boolean>();
  const inspect = (
    source: string,
    attrs: Record<string, string>,
    hidden: boolean,
  ) => {
    const url = remoteImageUrl(source, blockedHosts);
    if (!url) return undefined;
    const blocked = hidden || tinyMailImage(attrs) || trackingImageUrl(url);
    // A visible use of a shared URL permits fetching it for that use.
    candidates.set(url.href, (candidates.get(url.href) ?? true) && blocked);
    return undefined;
  };
  const initial = sanitizeMailHtml(html, attachments, inspect);
  if (!candidates.size) return { html: initial };
  const sources = [...candidates]
    .filter(([, blocked]) => !blocked || options.mode === "all")
    .map(([url]) => url);
  const results = options.mode
    ? await loadMailImages(sources, options.origin, options.mode === "all")
    : new Map();
  let rendered = initial;
  const displayed = new Set<string>();
  if (options.mode) {
    rendered = sanitizeMailHtml(
      html,
      attachments,
      (source, _attrs, _hidden, remaining) => {
        const url = remoteImageUrl(source, blockedHosts);
        const result = url && results.get(url.href);
        if (result?.status !== "loaded" || result.source.length > remaining)
          return undefined;
        displayed.add(url!.href);
        return result.source;
      },
    );
  }
  let blocked = 0;
  let unavailable = 0;
  let loaded = 0;
  for (const [source, tracker] of candidates) {
    const result = results.get(source);
    if ((tracker && options.mode !== "all") || result?.status === "blocked")
      blocked++;
    else if (displayed.has(source)) loaded++;
    else if (options.mode) unavailable++;
  }
  return {
    html: rendered,
    remoteImages: {
      available: Math.min(sources.length, mailImageLimit),
      blocked,
      loaded,
      unavailable,
    },
  };
};
