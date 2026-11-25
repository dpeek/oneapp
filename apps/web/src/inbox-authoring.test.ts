import { vi } from "vitest";
// These tests exercise state transitions without rendering StyleX components.
vi.mock("@oneapp/ui", async () => {
  const { Dialog } = await import(
    import.meta.resolve("@foldkit/ui", import.meta.resolve("@oneapp/ui"))
  );
  return { Dialog };
});
import { expect, it } from "@effect/vitest";
import { Dialog } from "@oneapp/ui";
import * as Compose from "./inbox-compose.ts";
import { outgoingAttachmentLimit } from "./inbox-contract.ts";
import * as Reply from "./inbox-inline-reply.ts";

const id = "0-8199999999990-00000000-0000-4000-8000-000000000000.eml";
const body = {
  text: "Keep this draft",
  html: "<p>Keep <strong>this draft</strong></p>",
};

it("preserves a formatted compose draft on send failure and resets it after sending", () => {
  let model = Compose.update(
    Compose.initial,
    Compose.Message.Opened({ from: "mail@example.net" }),
  ).model;
  model = Compose.update(model, Compose.Message.EditedBody({ body })).model;
  const cc = "copy@example.net";
  model = Compose.update(
    model,
    Compose.Message.EditedHeader({ field: "cc", value: cc }),
  ).model;
  expect(model.dialog.isOpen).toBe(true);
  model = Compose.update(model, Compose.Message.Submitted()).model;
  const request = model.request!;
  expect(Compose.update(model, Compose.Message.Closed()).model).toBe(model);
  expect(
    Compose.update(
      model,
      Compose.Message.GotDialogMessage({
        message: Dialog.Message.RequestedClose(),
      }),
    ).model,
  ).toBe(model);
  expect(
    Compose.update(
      model,
      Compose.Message.EditedBody({ body: { text: "late edit" } }),
    ).model.body,
  ).toEqual(body);
  model = Compose.update(
    model,
    Compose.Message.Failed({ request, error: "Retry" }),
  ).model;
  expect(model.body).toEqual(body);
  expect(model.headers.cc).toBe(cc);
  model = Compose.update(model, Compose.Message.Submitted()).model;
  model = Compose.update(
    model,
    Compose.Message.Sent({
      request: model.request!,
      saved: true,
      sentId: null,
      completion: null,
    }),
  ).model;
  expect(model.body).toEqual({ text: "" });
  expect(model.headers.cc).toBe("");
  expect(model.dialog.isOpen).toBe(false);
});

it("retains quick-reply formatting and the original target as new mail arrives", () => {
  let model = Reply.update(
    Reply.initial,
    Reply.Message.Edited({
      anchor: id,
      latest: id,
      latestIncoming: id,
      ...body,
    }),
  ).model;
  model = Reply.update(
    model,
    Reply.Message.Edited({
      anchor: id,
      latest: id.replace("9990", "9991"),
      latestIncoming: id,
      ...body,
    }),
  ).model;
  const result = Reply.update(model, Reply.Message.Submitted({ anchor: id }));
  expect(result.commands?.[0]?.args).toMatchObject({ target: id, reply: body });
  model = Reply.update(
    result.model,
    Reply.Message.Failed({ request: result.model.request!, error: "Retry" }),
  ).model;
  expect(model).toMatchObject({ ...body, target: id });
});

it("counts originals toward the attachment limit and preserves them after a failed forward", () => {
  const forward = Compose.Message.OpenedReply({
    from: "me@example.net",
    reply: {
      to: "",
      subject: "Fwd: Files",
      text: "Original message",
      mode: "forward",
      originalId: id,
      threaded: false,
      forwarded: [
        {
          part: 0,
          name: "report.pdf",
          mediaType: "application/pdf",
          size: outgoingAttachmentLimit,
          preview: "pdf",
        },
      ],
    },
  });
  let model = Compose.update(Compose.initial, forward).model;
  model = Compose.update(model, Compose.Message.PickedFiles()).model;
  model = Compose.update(
    model,
    Compose.Message.LoadedFiles({
      request: model.loadingFiles!,
      files: [{ filename: "extra.txt", type: "text/plain", content: "YQ==" }],
      error: null,
    }),
  ).model;
  expect(model.attachments).toEqual([]);
  expect(model.fileError).toContain("10 MB");
  const submitted = Compose.update(model, Compose.Message.Submitted());
  expect(submitted.commands?.[0]?.args).toMatchObject({
    reply: { mode: "forward", forwarded: [{ name: "report.pdf" }] },
  });
  model = Compose.update(
    submitted.model,
    Compose.Message.Failed({
      request: submitted.model.request!,
      error: "Offline",
    }),
  ).model;
  expect(model.reply?.forwarded).toHaveLength(1);
  model = Compose.update(
    model,
    Compose.Message.RemovedForwarded({ part: 0 }),
  ).model;
  expect(model.reply?.forwarded).toEqual([]);
  expect(model.fileError).toBeNull();
});
