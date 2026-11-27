import { hostUriMatch } from "@orumai/core/vault";

export const httpsPage = (address: string | undefined) => {
  if (!address || !/^https:\/\//iu.test(address)) return null;
  const url = URL.parse(address);
  return url?.protocol === "https:" && !url.username && !url.password
    ? url
    : null;
};

export const matchesLoginUri = (
  page: URL,
  uri: string,
  match?: number | null,
) => {
  // These saved modes provide no usable HTTPS origin in this popup.
  if (match === 4 || match === 5) return false;
  const saved = httpsPage(uri);
  if (!saved || saved.origin !== page.origin) return false;

  switch (match ?? hostUriMatch) {
    case 0: // Base domain
    case hostUriMatch:
      return true;
    case 2: // Starts with
      return page.href.startsWith(uri);
    case 3: // Exact
      return page.href === saved.href;
    default:
      return false;
  }
};
