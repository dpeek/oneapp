import { parse } from "tldts";
import { Schema } from "effect";
import { PersonEmail } from "./people-contract.ts";
import { iconHostname } from "./website-icon-host.ts";

export const isEmail = Schema.is(PersonEmail);
const personalDomains = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "rocketmail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "fastmail.com",
  "fastmail.fm",
  "hey.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "qq.com",
  "163.com",
  "126.com",
  "bigpond.com",
  "bigpond.net.au",
  "optusnet.com.au",
  "iinet.net.au",
  "internode.on.net",
]);

export const senderDomain = (address: string) => {
  const host = iconHostname(address.slice(address.lastIndexOf("@") + 1));
  if (!host) return null;
  const result = parse(host, { allowPrivateDomains: true });
  if (!result.domain || (!result.isIcann && !result.isPrivate)) return null;
  const personal =
    [...personalDomains].some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    ) || /^(?:yahoo|hotmail|outlook|live|gmx)\./u.test(result.domain);
  return { ...result, personal };
};

export const senderIconDomain = (address: string) => {
  if (!isEmail(address)) return null;
  const result = senderDomain(address);
  return result && !result.personal ? result.domain : null;
};
