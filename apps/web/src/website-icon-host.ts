const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const dnsSuffix = /^[a-z][a-z0-9-]+$/u;
const reservedSuffixes = new Set([
  "alt",
  "arpa",
  "corp",
  "example",
  "home",
  "i2p",
  "internal",
  "invalid",
  "lan",
  "local",
  "localhost",
  "onion",
  "test",
]);

export const iconHostname = (value: string) => {
  const host = value.toLowerCase().replace(/\.$/u, "");
  const labels = host.split(".");
  const suffix = labels.at(-1)!;
  return host.length <= 253 &&
    labels.length >= 2 &&
    dnsSuffix.test(suffix) &&
    !reservedSuffixes.has(suffix) &&
    labels.every((label) => dnsLabel.test(label))
    ? host
    : null;
};

export const websiteIconHostname = (uri: string) => {
  const site = URL.parse(uri);
  if (site?.protocol === "https:" || site?.protocol === "http:")
    return iconHostname(site.hostname);
  const [hostname] = uri.trim().split(/[/?#]/u, 1);
  return hostname ? iconHostname(hostname) : null;
};

export const websiteIconPath = (hostname: string) =>
  `/icons/${hostname}/icon.png?v=2`;
