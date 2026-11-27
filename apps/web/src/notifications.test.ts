import { expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { vi } from "vitest";
vi.mock("@orumai/ui", async () => {
  const state =
    await import("../../../packages/ui/src/item-action-menu-state.ts");
  return {
    ItemActionMenu: {
      ...state,
      create: () => ({ update: state.createUpdate() }),
    },
    Toast: await import("../../../packages/ui/src/toast-state.ts"),
  };
});
import * as Toast from "../../../packages/ui/src/toast-state.ts";
import * as Notifications from "./notifications.ts";
import * as Links from "./links.ts";

const link = { id: "link-one", url: "https://example.com", savedAt: 1 };
const ready = (): Links.Model => ({ ...Links.initial, records: [link] });
const editedCreation = (url: string) =>
  Links.update(
    Links.update(ready(), Links.Message.OpenedCreate()).model,
    Links.Message.EditedCreateUrl({ url }),
  ).model;
const submitting = () =>
  Links.update(editedCreation("example.org"), Links.Message.SubmittedCreate());
const applyOutcome = (
  out: Links.OutMessage | undefined,
  model = Notifications.init(),
) => {
  if (out?._tag === "Notify")
    return Notifications.show(model, out.notification);
  if (out?._tag === "DismissNotification")
    return Notifications.dismiss(model, out.key);
  throw new Error("Expected a notification outcome");
};

it("keeps validation and load failures inline without emitting a toast", () => {
  const invalid = Links.update(
    editedCreation("javascript:alert(1)"),
    Links.Message.SubmittedCreate(),
  );
  expect(invalid.model.creation?.validationError).toContain(
    "valid HTTP or HTTPS URL",
  );
  expect(invalid.outMessage).toBeUndefined();
  expect(invalid.commands).toBeUndefined();
  const loading = Links.update(Links.initial, Links.Message.Requested());
  const failed = Links.update(
    loading.model,
    Links.Message.Failed({
      request: loading.model.request!.id,
      error: "Could not load links.",
    }),
  );
  expect(failed.model.loadError).toBe("Could not load links.");
  expect(failed.outMessage).toBeUndefined();
  expect(
    Links.update(failed.model, Links.Message.Retried()).commands,
  ).toHaveLength(1);
});

it("preserves the dialog draft and shows save failures without emitting a toast", () => {
  const saving = submitting();
  const error = "Could not confirm the save. Reload to check your links.";
  const failure = Links.update(
    saving.model,
    Links.Message.Failed({ request: saving.model.request!.id, error }),
  );
  expect(failure.model.creation).toEqual({
    url: "example.org",
    validationError: null,
    saveError: error,
  });
  expect(failure.outMessage).toBeUndefined();
  const retry = Links.update(failure.model, Links.Message.SubmittedCreate());
  expect(retry.model.creation?.saveError).toBeNull();
  const saved = Links.update(
    retry.model,
    Links.Message.Saved({ request: retry.model.request!.id, link }),
  );
  expect(saved.model.creation).toBeNull();
});

it("retains a link on delete failure and only removes the matching target", () => {
  const deleting = Links.update(
    ready(),
    Links.Message.RequestedDeletion({ id: link.id }),
  );
  const request = deleting.model.request!.id;
  expect(
    Links.update(
      deleting.model,
      Links.Message.Deleted({ request, id: "another-link" }),
    ).model,
  ).toBe(deleting.model);
  const failed = Links.update(
    deleting.model,
    Links.Message.Failed({
      request,
      error: "Could not delete the link. Try again.",
    }),
  );
  expect(failed.model.records).toEqual([link]);
  expect(
    applyOutcome(failed.outMessage).model.toast.entries[0]?.payload.variant,
  ).toBe("Error");
  const retried = Links.update(
    failed.model,
    Links.Message.RequestedDeletion({ id: link.id }),
  );
  const deleted = Links.update(
    retried.model,
    Links.Message.Deleted({ request: retried.model.request!.id, id: link.id }),
  );
  expect(deleted.model.records).toEqual([]);
  expect(applyOutcome(deleted.outMessage).model.toast.entries).toEqual([]);
  const cleared = applyOutcome(
    deleted.outMessage,
    applyOutcome(failed.outMessage).model,
  );
  expect(cleared.model.toast.entries[0]?.animation.transitionState).toBe(
    "LeaveStart",
  );
});

it("ignores stale successes, failures, loads, and expired sessions", () => {
  const old = submitting();
  const request = old.model.request!.id;
  const current = submitting().model;
  for (const message of [
    Links.Message.Saved({ request, link }),
    Links.Message.Deleted({ request, id: link.id }),
    Links.Message.Loaded({ request, links: [] }),
    Links.Message.Failed({ request, error: "Old failure" }),
    Links.Message.SessionExpired({ request }),
  ]) {
    for (const model of [current, Links.initial]) {
      const result = Links.update(model, message);
      expect(result.model).toBe(model);
      expect(result.outMessage).toBeUndefined();
    }
  }
  const expired = Links.update(
    old.model,
    Links.Message.SessionExpired({ request }),
  );
  expect(expired.model).toBe(Links.initial);
  expect(expired.outMessage?._tag).toBe("SessionExpired");
});

it("does not start duplicate mutations while a request is running", () => {
  const { model } = submitting();
  for (const message of [
    Links.Message.SubmittedCreate(),
    Links.Message.RequestedDeletion({ id: link.id }),
    Links.Message.Retried(),
  ]) {
    expect(Links.update(model, message)).toEqual({ model });
  }
});

it("coalesces repeated notifications and safely replaces a leaving entry", () => {
  const event = {
    key: "links-save",
    variant: "Error" as const,
    title: "Could not save.",
  };
  let model = Notifications.show(Notifications.init(), event).model;
  const id = model.toast.entries[0]!.id;
  model = Notifications.show(model, event).model;
  expect(model.toast.entries).toHaveLength(1);
  model = Notifications.update(
    model,
    Notifications.wrap(model.generation)(
      Toast.Message.Dismissed({ entryId: id }),
    ),
  ).model;
  model = Notifications.show(model, event).model;
  expect(model.keys[event.key]).not.toBe(id);
  expect(model.toast.entries).toHaveLength(2);
});

it("clears account notifications and rejects all messages from the previous generation", () => {
  const old = Notifications.show(Notifications.init(), {
    key: "mail-compose",
    variant: "Success",
    title: "Email sent.",
  }).model;
  const cleared = Notifications.clear(old);
  const current = Notifications.show(cleared, {
    key: "links-save",
    variant: "Error",
    title: "Could not save.",
  }).model;
  expect(cleared.toast.entries).toEqual([]);
  expect(cleared.keys).toEqual({});
  expect(current.toast.entries[0]?.id).not.toBe(old.toast.entries[0]?.id);
  const delayed = Notifications.Message.GotToast({
    generation: old.generation,
    message: Toast.Message.DismissedAll(),
  });
  expect(
    Notifications.update(
      current,
      Schema.decodeUnknownSync(Notifications.Message)(delayed),
    ).model,
  ).toBe(current);
  expect(
    Notifications.update(
      current,
      Notifications.wrap(current.generation)(Toast.Message.DismissedAll()),
    ).model.toast.entries[0]?.animation.transitionState,
  ).toBe("LeaveStart");
});

it("coalesces deployments and keeps the reload action available after activation", () => {
  const notification = {
    key: "task-deployment",
    variant: "Success" as const,
    title: "Deployed: First task",
    action: Notifications.Action.ReloadApp(),
  };
  const first = Notifications.show(Notifications.init(), notification).model;
  const { model } = Notifications.show(first, {
    ...notification,
    title: "Deployed: Second task",
  });
  expect(model.toast.entries).toHaveLength(1);
  const entry = model.toast.entries[0]!;
  expect(entry.id).toBe(first.toast.entries[0]?.id);
  expect(entry.payload).toMatchObject({
    title: "Deployed: Second task",
    actionLabel: "Reload app",
  });
  expect(Option.isNone(entry.maybeDuration)).toBe(true);
  expect(
    Notifications.update(
      model,
      Notifications.wrap(model.generation)(
        Toast.Message.ActivatedToastAction({ id: entry.id }),
      ),
    ),
  ).toEqual({ model, outMessage: notification.action });
});

it("silently dismisses only the requested key, clears its action immediately, and is safe to repeat", () => {
  const id = "0-8199999999990-00000000-0000-4000-8000-000000000000.eml";
  let model = Notifications.show(Notifications.init(), {
    key: "deleted",
    variant: "Success",
    title: "Email deleted.",
    action: Notifications.Action.RestoreMail({ id }),
  }).model;
  model = Notifications.show(model, {
    key: "unrelated",
    variant: "Error",
    title: "Unrelated failure",
  }).model;
  const toastId = model.keys.deleted!;
  const result = Notifications.dismiss(model, "deleted");
  expect(result.model.toast.entries).toHaveLength(2);
  expect(
    result.model.toast.entries.find((entry) => entry.id === toastId)?.animation
      .transitionState,
  ).toBe("LeaveStart");
  expect(result.commands?.length).toBeGreaterThan(0);
  expect(result.model.keys).toEqual({ unrelated: model.keys.unrelated });
  expect(result.model.actions[toastId]).toBeUndefined();
  expect(
    Notifications.update(
      result.model,
      Notifications.wrap(model.generation)(
        Toast.Message.ActivatedToastAction({ id: toastId }),
      ),
    ).outMessage,
  ).toBeUndefined();
  expect(Notifications.dismiss(result.model, "deleted")).toEqual({
    model: result.model,
  });
});
