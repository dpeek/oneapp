import { Effect, Redacted, Schema } from "effect";
import { CliError } from "./errors.ts";

export const request = (
  origin: string,
  token: Redacted.Redacted<string>,
  path: string,
  options?: RequestInit,
) =>
  Effect.tryPromise({
    try: (signal) => {
      const headers = new Headers(options?.headers);
      headers.set("authorization", `Bearer ${Redacted.value(token)}`);
      return fetch(new URL(path, origin), {
        ...options,
        headers,
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
    },
    catch: () =>
      new CliError({ message: "Could not reach the Orumai server." }),
  });

export const requireSuccess = Effect.fnUntraced(function* (response: Response) {
  if (response.status === 401) {
    return yield* new CliError({
      message:
        "The CLI token is invalid, expired, or revoked. Run oru auth login again.",
    });
  }
  if (!response.ok)
    return yield* new CliError({
      message: `Orumai returned HTTP ${response.status}.`,
    });
});

export const readResponse = <A>(
  schema: Schema.Decoder<A>,
  response: Response,
) =>
  Effect.tryPromise({
    try: async () => Schema.decodeUnknownSync(schema)(await response.json()),
    catch: () =>
      new CliError({ message: "Orumai returned an unexpected response." }),
  });
