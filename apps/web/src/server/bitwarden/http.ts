import { privateHeaders } from "../api-response.ts";

export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: privateHeaders });
export const error = (message: string, status = 400) =>
  json({ error: message }, status);
export const readBody = async (request: Request, limit: number) => {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const text = new TextDecoder();
  let body = "";
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) return body + text.decode();
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    body += text.decode(value, { stream: true });
  }
};

export const contentType = (request: Request) =>
  request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();

export const empty = () =>
  new Response(null, { status: 204, headers: privateHeaders });

export const readJson = async (
  request: Request,
  limit: number,
): Promise<unknown> => {
  if (contentType(request) !== "application/json") return null;
  const body = await readBody(request, limit);
  try {
    return body === null ? null : JSON.parse(body);
  } catch {
    return null;
  }
};
