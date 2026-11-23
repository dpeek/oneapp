import { expect, it } from "@effect/vitest";
import { folderPath, mailMessagePage, mailRouteFor } from "./inbox-contract.ts";

const key = "0-8199999999990-00000000-0000-4000-8000-000000000000";
const inboxId = `${key}.eml`;

it("uses /mail for the inbox and its folders", () => {
  expect(folderPath("inbox")).toBe("/mail");
  expect(folderPath("trash")).toBe("/mail/trash");
  expect(mailRouteFor("/mail/trash")).toEqual({ folder: "trash", id: null });
  expect(mailRouteFor("/mail")).toEqual({ folder: "inbox", id: null });
  expect(mailRouteFor("/mail/noise")).toEqual({ folder: "noise", id: null });
  expect(mailRouteFor("/inbox")).toBeNull();
  expect(mailRouteFor(`/inbox/${key}`)).toBeNull();
});

it("routes clean and original .eml links for received mail", () => {
  for (const folder of ["inbox", "noise", "archive"] as const) {
    const path = mailMessagePage(folder, inboxId);
    expect(path).toBe(`${folderPath(folder)}/${key}`);
    expect(mailRouteFor(path)).toEqual({ folder, id: inboxId });
    expect(mailRouteFor(`${path}.eml`)).toEqual({ folder, id: inboxId });
  }

  const isoId =
    "2026-11-20T00:00:00.000Z-00000000-0000-4000-8000-000000000000.eml";
  expect(mailRouteFor(mailMessagePage("inbox", isoId))).toEqual({
    folder: "inbox",
    id: isoId,
  });
});

it("distinguishes received and sent mail with matching key stems", () => {
  for (const folder of ["all", "trash"] as const) {
    const received = mailMessagePage(folder, inboxId);
    const sent = mailMessagePage(folder, key);
    expect(received).toBe(`/mail/${folder}/received/${key}`);
    expect(sent).toBe(`/mail/${folder}/${key}`);
    expect(mailRouteFor(received)).toEqual({ folder, id: inboxId });
    expect(mailRouteFor(`${sent}.eml`)).toEqual({ folder, id: inboxId });
    expect(mailRouteFor(sent)).toEqual({ folder, id: key });
  }
  expect(mailRouteFor(mailMessagePage("sent", key))).toEqual({
    folder: "sent",
    id: key,
  });
  expect(mailRouteFor(`/mail/sent/${inboxId}`)).toBeNull();
});

it("validates recipient lists and attachment limits before sending", async () => {
  const { Schema } = await import("effect");
  const { InboxDraft, OutgoingAttachments } =
    await import("./inbox-contract.ts");
  const draft = {
    to: "a@example.net, b@example.net",
    cc: "c@example.net",
    subject: "Files",
    text: "Attached",
  };
  expect(Schema.is(InboxDraft)(draft)).toBe(true);
  for (const to of [
    "a@example.net,",
    "invalid",
    "a@example.net\r\nBcc: evil@example.net",
    Array(21).fill("a@example.net").join(","),
  ])
    expect(Schema.is(InboxDraft)({ ...draft, to })).toBe(false);
  const file = {
    filename: "test.bin",
    type: "application/octet-stream",
    content: "AAECA/8=",
  };
  expect(Schema.is(OutgoingAttachments)([file])).toBe(true);
  for (const files of [
    [{ ...file, content: "bad=".repeat(4) }],
    [{ ...file, filename: "../test" }],
    Array(21).fill(file),
    Array(2).fill({ ...file, content: "AAAA".repeat(2 * 1024 * 1024) }),
  ])
    expect(Schema.is(OutgoingAttachments)(files)).toBe(false);
});
