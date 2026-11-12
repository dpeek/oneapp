import { HttpServerResponse } from "effect/http";

export const privateHeaders = { "cache-control": "no-store" };
export const jsonError = (status: number, error: string) =>
  HttpServerResponse.json({ error }, { status, headers: privateHeaders });
