import { HttpServerResponse } from "effect/http";
import { Schema } from "effect";
import { FileName } from "../files-contract.ts";

export const privateHeaders = { "cache-control": "no-store" };
export const jsonError = (status: number, error: string) =>
  HttpServerResponse.json({ error }, { status, headers: privateHeaders });

export const readFileName = (header: string | undefined) => {
  try {
    const name = decodeURIComponent(header ?? "");
    return Schema.is(FileName)(name) ? name : null;
  } catch {
    return null;
  }
};

export const attachmentDisposition = (name: string) => {
  const fallback = name.replaceAll(/[^\x20-\x7e]|[%"\\]/gu, "_");
  const encoded = encodeURIComponent(name).replaceAll(
    /['()*]/gu,
    (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};
