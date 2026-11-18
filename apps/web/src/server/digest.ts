import { Base64Url } from "effect/encoding";

const encoder = new TextEncoder();
export const digest = async (value: string) =>
  Base64Url.encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );
