import type { ItemType } from "./vault-item-content.ts";
import { websiteIconPath } from "./website-icon-host.ts";

const itemPaths = {
  1: [
    "M15.5 3a5.5 5.5 0 0 0-5.2 7.3L3 17.6V21h3.4l2.2-2.2v-2.3h2.3l2.8-2.8A5.5 5.5 0 1 0 15.5 3Z",
    "M17 7h.01",
  ],
  2: [
    "M6 3h8l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z",
    "M14 3v5h4M8 12h6m-6 4h6",
  ],
  3: [
    "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
    "M3 10h18M7 15h3",
  ],
  4: [
    "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2",
  ],
  5: [
    "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
    "m7 9 3 3-3 3m6 0h4",
  ],
  6: ["m3 9 9-5 9 5H3Zm2 11h14M6 12v5m6-5v5m6-5v5"],
  7: [
    "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
    "M14 10h4m-4 4h4M10 10a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-4 5a2.5 2.5 0 0 1 5 0",
  ],
  8: [
    "M7 3h12v18H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z",
    "M16 11a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm-8 0h8m-4-4a7 7 0 0 0 0 8m0-8a7 7 0 0 1 0 8",
  ],
} satisfies Record<ItemType, readonly string[]>;

const svgNamespace = "http://www.w3.org/2000/svg";

export const vaultItemIcon = (type: ItemType, hostname?: string) => {
  const element = document.createElement("span");
  element.className = "vault-row-icon";
  element.setAttribute("aria-hidden", "true");
  const fallback = document.createElementNS(svgNamespace, "svg");
  fallback.setAttribute("viewBox", "0 0 24 24");
  fallback.setAttribute("fill", "none");
  fallback.setAttribute("stroke", "currentColor");
  fallback.setAttribute("stroke-width", "1.75");
  fallback.setAttribute("stroke-linecap", "round");
  fallback.setAttribute("stroke-linejoin", "round");
  for (const d of itemPaths[type]) {
    const path = document.createElementNS(svgNamespace, "path");
    path.setAttribute("d", d);
    fallback.append(path);
  }
  element.append(fallback);
  if (type === 1 && hostname) {
    const icon = document.createElement("img");
    icon.alt = "";
    icon.loading = "lazy";
    icon.decoding = "async";
    icon.referrerPolicy = "no-referrer";
    icon.addEventListener("load", () => fallback.remove(), { once: true });
    icon.addEventListener("error", () => icon.remove(), { once: true });
    icon.src = websiteIconPath(hostname);
    element.append(icon);
  }
  return element;
};
