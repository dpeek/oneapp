import {
  Link,
  LinkList,
  linkPath,
  linksPath,
  normalizeLinkUrl,
  SaveLink,
} from "@oneapp/core/links";
import { Effect, Schema } from "effect";

const isSaveLink = Schema.is(SaveLink);
const bareWebAddress =
  /^(?:localhost|\[[^\]]+\]|[^./:?#\\\s]+(?:\.[^./:?#\\\s]+)+)\.?(?::\d+)?(?:[/?#]|$)/i;

export const parseLinkInput = (value: string): typeof SaveLink.Type | null => {
  const text = value.trim();
  const address = text.replace(/^\/\//, "");
  const input = {
    url:
      bareWebAddress.test(address) && !address.includes("\\")
        ? `https://${address}`
        : text,
  };
  return isSaveLink(input) ? { url: normalizeLinkUrl(input.url) } : null;
};

export const readLinks = Effect.tryPromise(async (signal) => {
  const response = await fetch(linksPath, { signal, cache: "no-store" });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Could not load links");
  return Schema.decodeUnknownSync(LinkList)(await response.json());
});

export const saveLink = (url: string) =>
  Effect.tryPromise(async (signal) => {
    const response = await fetch(linksPath, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-effect-auth-csrf": "1",
      },
      body: JSON.stringify({ url }),
      signal,
    });
    if (response.status === 401) return null;
    if (!response.ok) throw new Error("Could not save link");
    return Schema.decodeUnknownSync(Link)(await response.json());
  });

export const deleteLink = (id: string) =>
  Effect.tryPromise(async (signal) => {
    const response = await fetch(linkPath(id), {
      method: "DELETE",
      headers: { "x-effect-auth-csrf": "1" },
      signal,
    });
    if (response.status === 401) return false;
    if (response.status !== 204 && response.status !== 404)
      throw new Error("Could not delete link");
    return true;
  });
