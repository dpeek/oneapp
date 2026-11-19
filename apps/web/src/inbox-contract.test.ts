import { expect, it } from "@effect/vitest";
import { folderPath, mailMessagePage, mailRouteFor } from "./inbox-contract.ts";

const key = "0-8199999999990-00000000-0000-4000-8000-000000000000";
const inboxId = `${key}.eml`;

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
  const received = mailMessagePage("all", inboxId);
  const sent = mailMessagePage("all", key);
  expect(received).toBe(`/inbox/all/received/${key}`);
  expect(sent).toBe(`/inbox/all/${key}`);
  expect(mailRouteFor(received)).toEqual({ folder: "all", id: inboxId });
  expect(mailRouteFor(`${sent}.eml`)).toEqual({ folder: "all", id: inboxId });
  expect(mailRouteFor(sent)).toEqual({ folder: "all", id: key });
  expect(mailRouteFor(mailMessagePage("sent", key))).toEqual({
    folder: "sent",
    id: key,
  });
  expect(mailRouteFor(`/inbox/sent/${inboxId}`)).toBeNull();
});
