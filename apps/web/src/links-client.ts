import { Link, LinkList, linksPath } from "@oneapp/core/links";
import { Effect, Schema } from "effect";

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
