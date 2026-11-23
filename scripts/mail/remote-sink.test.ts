import { expect, it, vi } from "@effect/vitest";
import { openRemoteMailSink } from "./remote-sink.ts";
import type { MailImportPlan } from "../../packages/core/src/mail-import.ts";

const plan: MailImportPlan = {
  version: 1,
  snapshotId: "7b8d3e60-7439-4d39-b4d0-3998cef717b2",
  inventorySha256: "a".repeat(64),
  manifestSha256: "b".repeat(64),
  mappingHash: "c".repeat(64),
  asOf: "2026-11-23T00:00:00Z",
  sourceAccount: "icloud:test@icloud.com",
  entries: [],
};
const token = `one_${"x".repeat(43)}`;
const destination = {
  version: 1,
  origin: "https://oneapp.example",
  mailboxId: "personal",
  ownerAccountId: "owner",
  name: "Personal",
  maxMessageBytes: 25 * 1024 * 1024,
  maxPlanBytes: 1024 * 1024,
};
it("refuses ambiguous destinations before transmitting credentials", async () => {
  const fetch = vi.fn();
  for (const url of [
    "http://example.com",
    "https://oneapp.example/path",
    "https://name:secret@oneapp.example",
  ]) {
    await expect(
      openRemoteMailSink(url, "personal", plan, token, {
        fetch: fetch as unknown as typeof globalThis.fetch,
        sleep: async () => {},
      }),
    ).rejects.toThrow();
  }
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects a destination mismatch before creating an import run", async () => {
  const fetch = vi.fn(async () =>
    Response.json({ ...destination, mailboxId: "family" }),
  );
  await expect(
    openRemoteMailSink(destination.origin, "personal", plan, token, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    }),
  ).rejects.toThrow("destination");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("retries lost and transient responses but stops immediately for revoked access", async () => {
  const sleep = vi.fn(async () => {});
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error("connection lost"))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json(destination))
    .mockResolvedValueOnce(new Response(null, { status: 401 }));
  const remote = await openRemoteMailSink(
    destination.origin,
    "personal",
    plan,
    token,
    { fetch: fetch as unknown as typeof globalThis.fetch, sleep },
  );
  expect(sleep).toHaveBeenCalledTimes(2);
  await expect(remote.begin()).rejects.toThrow("expired or revoked");
  expect(fetch).toHaveBeenCalledTimes(4);
  for (const [url, init] of fetch.mock.calls) {
    expect(String(url).startsWith(destination.origin + "/")).toBe(true);
    expect(init).toMatchObject({
      redirect: "error",
      credentials: "omit",
      headers: { authorization: `Bearer ${token}` },
    });
  }
});
