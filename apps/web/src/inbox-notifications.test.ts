import { expect, it } from "@effect/vitest";
import { Duration, Option } from "effect";
import { vi } from "vitest";
vi.mock("@oneapp/ui", async () => {
  const { Menu, Dialog, Popover } = await import(
    import.meta.resolve("@foldkit/ui", import.meta.resolve("@oneapp/ui"))
  );
  return {
    Dialog,
    DropdownMenu: Menu,
    Sheet: Dialog,
    Popover,
    Toast: await import("../../../packages/ui/src/toast-state.ts"),
  };
});
import { DropdownMenu } from "@oneapp/ui";
import * as Toast from "../../../packages/ui/src/toast-state.ts";
import * as Inbox from "./inbox.ts";
import * as Compose from "./inbox-compose.ts";
import * as Reply from "./inbox-inline-reply.ts";
import * as Recovery from "./inbox-recovery.ts";
import * as Notifications from "./notifications.ts";

const first = "0-8199999999990-00000000-0000-4000-8000-000000000000.eml";
const second = first.replace("9990", "9991");
const applyOutcome = (
  out: Inbox.OutMessage | undefined,
  model = Notifications.init(),
) => {
  if (out?._tag === "Notify")
    return Notifications.show(model, out.notification).model;
  if (out?._tag === "DismissNotification")
    return Notifications.dismiss(model, out.key).model;
  throw new Error("Expected notification outcome");
};
const notification = (out: Inbox.OutMessage | undefined) => {
  if (out?._tag !== "Notify")
    throw new Error("Expected a visible notification");
  return out.notification;
};
const click = (model: Notifications.Model, id: string) =>
  Notifications.update(
    model,
    Notifications.wrap(model.generation)(
      Toast.Message.ActivatedToastAction({ id }),
    ),
  );
const deletion = (id: string, request: string) =>
  Inbox.update(
    {
      ...Inbox.initial,
      deleteRequest: { id, request, folder: "inbox" },
    },
    Inbox.Message.DeletedEntry({ id, request }),
  );
const compose = (): typeof Inbox.Model.Type => ({
  ...Inbox.initial,
  compose: {
    ...Compose.initial,
    from: "me@example.com",
    request: "send",
    body: { text: "Draft", html: "<p>Draft</p>" },
  },
});

it("keeps compose validation inline and preserves a failed send draft without duplicate inline feedback", () => {
  const state = compose();
  const invalid = Inbox.update(
    state,
    Inbox.Message.GotComposeMessage({
      message: Compose.Message.Failed({
        request: "send",
        error: "Enter valid recipients.",
      }),
    }),
  );
  expect(invalid.model.compose.error).toBe("Enter valid recipients.");
  expect(invalid.outMessage).toBeUndefined();
  const failed = Inbox.update(
    state,
    Inbox.Message.GotComposeMessage({
      message: Compose.Message.SendFailed({
        request: "send",
        error: "Could not confirm whether the email was sent.",
      }),
    }),
  );
  expect(failed.model.compose.body).toEqual(state.compose.body);
  expect(failed.model.compose.from).toBe(state.compose.from);
  expect(failed.model.compose.error).toBeNull();
  expect(notification(failed.outMessage).variant).toBe("Error");
  expect(notification(failed.outMessage).action).toBeUndefined();
});

it.each([
  [true, null, "Success"],
  [false, null, "Warning"],
  [true, "failed", "Warning"],
  [true, "new-mail", "Info"],
] as const)(
  "reports sent outcome saved=%s completion=%s without offering resend",
  (saved, completion, variant) => {
    const message = Inbox.Message.GotComposeMessage({
      message: Compose.Message.Sent({
        request: "send",
        saved,
        completion,
        sentId: null,
      }),
    });
    const result = Inbox.update(compose(), message);
    expect(result.model.compose.from).toBeNull();
    const toast = applyOutcome(result.outMessage).toast.entries[0]!;
    expect(toast.payload.variant).toBe(variant);
    expect(toast.payload.title).toContain("Email sent.");
    if (!saved)
      expect(toast.payload.title).toContain("Could not save a copy in Sent.");
    if (completion === "failed")
      expect(toast.payload.title).toContain(
        "Could not mark the conversation done.",
      );
    expect(toast.payload.actionLabel).toBeUndefined();
    expect(Option.isNone(toast.maybeDuration)).toBe(variant === "Warning");
    expect(Inbox.update(result.model, message).outMessage).toBeUndefined();
    expect(Inbox.update(Inbox.initial, message).outMessage).toBeUndefined();
  },
);

it("reports reply failures and success after navigation while retaining the original failed draft", () => {
  const state: typeof Inbox.Model.Type = {
    ...Inbox.initial,
    selected: second,
    quickReply: {
      ...Reply.initial,
      anchor: first,
      target: first,
      request: "reply",
      text: "Original draft",
    },
  };
  const failure = Inbox.Message.GotQuickReplyMessage({
    message: Reply.Message.Failed({
      request: "reply",
      error: "Unconfirmed send",
    }),
  });
  const failed = Inbox.update(state, failure);
  expect(failed.model.quickReply).toMatchObject({
    text: "Original draft",
    target: first,
  });
  expect(notification(failed.outMessage).title).toBe("Unconfirmed send");
  expect(Inbox.update(failed.model, failure).outMessage).toBeUndefined();
  const result = Inbox.update(
    state,
    Inbox.Message.GotQuickReplyMessage({
      message: Reply.Message.Sent({
        request: "reply",
        saved: false,
        completion: null,
        sentId: null,
      }),
    }),
  );
  expect(notification(result.outMessage).variant).toBe("Warning");
  expect(result.model.selected).toBe(second);
  expect(result.model.quickReply.text).toBe("");
});

it("routes each delete Undo to its original message after navigation and a later delete, only once", () => {
  let notifications = applyOutcome(deletion(first, "delete-one").outMessage);
  const firstToast = notifications.toast.entries[0]!.id;
  expect(
    Duration.toMillis(
      Option.getOrThrow(notifications.toast.entries[0]!.maybeDuration),
    ),
  ).toBe(10_000);
  notifications = applyOutcome(
    deletion(second, "delete-two").outMessage,
    notifications,
  );
  const activated = click(notifications, firstToast);
  expect(activated.outMessage).toMatchObject(
    Notifications.Action.RestoreMail({ id: first }),
  );
  expect(click(activated.model, firstToast).outMessage).toBeUndefined();
  expect(activated.model.actions[firstToast]).toBeUndefined();
  const result = Inbox.update(
    { ...Inbox.initial, folder: "sent", selected: second },
    Inbox.Message.ActivatedNotification({ action: activated.outMessage! }),
  );
  expect(result.commands?.[0]?.args).toMatchObject({ id: first });
  expect(result.model.selected).toBe(second);
  expect(result.model.recovery.restoring).toBe(first);
});

it("retains targeted Undo when another restore is running and when restoration fails", () => {
  const busy: typeof Inbox.Model.Type = {
    ...Inbox.initial,
    recovery: { request: "restore", restoring: second },
  };
  const result = Inbox.update(
    busy,
    Inbox.Message.ActivatedNotification({
      action: Notifications.Action.RestoreMail({ id: first }),
    }),
  );
  expect(result.model).toBe(busy);
  expect(result.commands).toBeUndefined();
  expect(notification(result.outMessage).action).toMatchObject(
    Notifications.Action.RestoreMail({ id: first }),
  );
  const failed = Inbox.update(
    busy,
    Inbox.Message.GotRecoveryMessage({
      message: Recovery.Message.Failed({ request: "restore" }),
    }),
  );
  expect(notification(failed.outMessage).action).toMatchObject(
    Notifications.Action.RestoreMail({ id: second }),
  );
  expect(failed.model.recovery.request).toBeNull();
  expect(
    Inbox.update(
      failed.model,
      Inbox.Message.GotRecoveryMessage({
        message: Recovery.Message.Failed({ request: "restore" }),
      }),
    ).outMessage,
  ).toBeUndefined();
});

it("silently clears deletion Undo after restore and rejects mismatched restore responses", () => {
  const queued = applyOutcome(deletion(first, "delete").outMessage);
  const toastId = queued.toast.entries[0]!.id;
  const state: typeof Inbox.Model.Type = {
    ...Inbox.initial,
    recovery: { request: "restore", restoring: first },
  };
  const mismatch = Inbox.update(
    state,
    Inbox.Message.GotRecoveryMessage({
      message: Recovery.Message.Restored({ request: "restore", id: second }),
    }),
  );
  expect(mismatch.model.recovery).toBe(state.recovery);
  expect(mismatch.outMessage).toBeUndefined();
  const restored = Inbox.update(
    state,
    Inbox.Message.GotRecoveryMessage({
      message: Recovery.Message.Restored({ request: "restore", id: first }),
    }),
  );
  const notifications = applyOutcome(restored.outMessage, queued);
  const latest = notifications.toast.entries.at(-1)!;
  expect(notifications.toast.entries).toHaveLength(1);
  expect(latest.id).toBe(toastId);
  expect(latest.animation.transitionState).toBe("LeaveStart");
  expect(applyOutcome(restored.outMessage).toast.entries).toEqual([]);
  expect(notifications.actions[toastId]).toBeUndefined();
  expect(click(notifications, toastId).outMessage).toBeUndefined();
});

it.each([true, false])(
  "keeps archive failures visible but clears them quietly after success (archived=%s)",
  (archived) => {
    const state: typeof Inbox.Model.Type = {
      ...Inbox.initial,
      archiveRequest: {
        id: first,
        request: "archive",
        folder: "inbox",
        selected: first,
        archived,
      },
    };
    const failure = Inbox.Message.ArchiveFailed({
      request: "archive",
      error: "Could not update Archive.",
    });
    const failed = Inbox.update(state, failure);
    expect(notification(failed.outMessage).variant).toBe("Error");
    expect(notification(failed.outMessage).action).toBeUndefined();
    const queued = applyOutcome(failed.outMessage);
    const message = Inbox.Message.ArchiveChanged({ request: "archive" });
    const succeeded = Inbox.update(state, message);
    expect(succeeded.model.archiveRequest).toBeNull();
    expect(succeeded.commands?.length).toBeGreaterThan(0);
    expect(applyOutcome(succeeded.outMessage).toast.entries).toEqual([]);
    const cleared = applyOutcome(succeeded.outMessage, queued);
    expect(cleared.toast.entries).toHaveLength(1);
    expect(cleared.toast.entries[0]?.animation.transitionState).toBe(
      "LeaveStart",
    );
    expect(Inbox.update(succeeded.model, message).outMessage).toBeUndefined();
    expect(Inbox.update(failed.model, failure).outMessage).toBeUndefined();
  },
);

it("rejects wrong delete targets and clears action payloads across sign-out generations", () => {
  const state: typeof Inbox.Model.Type = {
    ...Inbox.initial,
    deleteRequest: { id: first, folder: "inbox", request: "delete" },
  };
  expect(
    Inbox.update(
      state,
      Inbox.Message.DeletedEntry({ id: second, request: "delete" }),
    ).model,
  ).toBe(state);
  const queued = applyOutcome(deletion(first, "delete").outMessage);
  const reset = Notifications.clear(queued);
  expect(reset.actions).toEqual({});
  const stale = Notifications.update(
    reset,
    Notifications.wrap(queued.generation)(
      Toast.Message.ActivatedToastAction({ id: queued.toast.entries[0]!.id }),
    ),
  );
  expect(stale.model).toBe(reset);
  expect(stale.outMessage).toBeUndefined();
  expect(
    Inbox.update(
      Inbox.initial,
      Inbox.Message.DeletedEntry({ request: "delete", id: first }),
    ).outMessage,
  ).toBeUndefined();
});

it("deletes the active message and preserves its subject through navigation and Undo failure", () => {
  const submitted = Inbox.update(
    {
      ...Inbox.initial,
      active: { id: first, folder: "inbox" },
      thread: {
        messages: [
          {
            id: first,
            folder: "inbox",
            from: "Alex",
            to: "Me",
            subject: "Original subject",
            timestamp: 1,
          },
        ],
      },
    },
    Inbox.Message.RequestedMessageDelete({ id: first }),
  );
  expect(submitted.commands).toContainEqual(
    expect.objectContaining({
      args: expect.objectContaining({ id: first, folder: "inbox" }),
    }),
  );
  const duplicate = Inbox.update(
    submitted.model,
    Inbox.Message.RequestedMessageDelete({ id: first }),
  );
  expect(duplicate.model.deleteRequest).toBe(submitted.model.deleteRequest);
  const deleted = Inbox.update(
    { ...submitted.model, selected: second, thread: null },
    Inbox.Message.DeletedEntry({
      id: first,
      request: submitted.model.deleteRequest!.request,
    }),
  );
  expect(notification(deleted.outMessage).description).toBe("Original subject");
  const action = notification(deleted.outMessage).action!;
  const undo = Inbox.update(
    deleted.model,
    Inbox.Message.ActivatedNotification({ action }),
  );
  const failed = Inbox.update(
    undo.model,
    Inbox.Message.GotRecoveryMessage({
      message: Recovery.Message.Failed({
        request: undo.model.recovery.request!,
      }),
    }),
  );
  expect(notification(failed.outMessage).description).toBe("Original subject");
  expect(notification(failed.outMessage).action).toEqual(action);
});

const mailEntry = {
  id: first,
  from: "Alex <alex@example.com>",
  to: "me@example.com",
  subject: "Original message",
  receivedAt: 1,
  text: "Body",
  preview: "complete" as const,
  unread: false,
  people: {
    sender: { address: "alex@example.com", name: "Alex" },
    members: [],
  },
};
const reader = (): typeof Inbox.Model.Type => ({
  ...Inbox.initial,
  selected: first,
  active: { id: first, folder: "inbox" },
  entry: mailEntry,
  thread: {
    messages: [
      {
        id: first,
        from: mailEntry.from,
        to: mailEntry.to,
        subject: mailEntry.subject,
        folder: "inbox",
        timestamp: 1,
        unread: false,
      },
    ],
    senderRule: { address: "alex@example.com", priority: "automatic" },
  },
});
const menuAction = (item: string) =>
  Inbox.Message.GotMessageMenuMessage({
    message: DropdownMenu.Message.SelectedItem({ item, index: 0 }),
  });
const priorityAction = Inbox.Message.GotConversationMenuMessage({
  message: DropdownMenu.Message.SelectedItem({ item: "noise", index: 0 }),
});

it.each([true, false])(
  "reports only explicit read-status failures after navigation (unread=%s)",
  (unread) => {
    const state = reader();
    const pending = Inbox.update(
      { ...state, entry: { ...mailEntry, unread: !unread }, thread: null },
      menuAction("toggleUnread"),
    );
    const request = pending.model.readRequests[first]!.request;
    expect(pending.model.readRequests[first]).toMatchObject({
      userInitiated: true,
      unread,
    });
    const navigated = Inbox.update(
      pending.model,
      Inbox.Message.Opened({ folder: "archive", id: second }),
    );
    const message = Inbox.Message.ReadStatusFailed({ request, id: first });
    const failed = Inbox.update(navigated.model, message);
    expect(notification(failed.outMessage)).toMatchObject({
      variant: "Error",
      description: "Original message",
    });
    expect(notification(failed.outMessage).title).toContain(
      unread ? "mark email unread" : "mark email read",
    );
    expect(failed.model.readFailed).toBeNull();
    expect(failed.model.selected).toBe(second);
    expect(Inbox.update(failed.model, message).outMessage).toBeUndefined();
    expect(Inbox.update(Inbox.initial, message).outMessage).toBeUndefined();
    const success = Inbox.update(
      pending.model,
      Inbox.Message.UpdatedReadStatus({ request, id: first, unread }),
    );
    expect(success.model.entry).toMatchObject({ unread });
    const queued = applyOutcome(failed.outMessage);
    expect(applyOutcome(success.outMessage).toast.entries).toEqual([]);
    expect(
      applyOutcome(success.outMessage, queued).toast.entries[0]?.animation
        .transitionState,
    ).toBe("LeaveStart");
  },
);

it("keeps automatic mark-read failures inline and ignores mismatched or old completions", () => {
  const loaded = Inbox.update(
    { ...reader(), entryRequest: "load" },
    Inbox.Message.LoadedEntry({
      request: "load",
      entry: { ...mailEntry, unread: true },
    }),
  );
  const request = loaded.model.readRequests[first]!.request;
  expect(loaded.model.readRequests[first]!.userInitiated).toBe(false);
  expect(loaded.outMessage).toBeUndefined();
  for (const message of [
    Inbox.Message.ReadStatusFailed({ request, id: second }),
    Inbox.Message.ReadStatusFailed({ request: "old", id: first }),
    Inbox.Message.UpdatedReadStatus({ request, id: first, unread: true }),
  ])
    expect(Inbox.update(loaded.model, message)).toEqual({
      model: loaded.model,
    });
  const failed = Inbox.update(
    loaded.model,
    Inbox.Message.ReadStatusFailed({ request, id: first }),
  );
  expect(failed.model.readFailed).toBe(first);
  expect(failed.outMessage).toBeUndefined();
  const saved = Inbox.update(
    loaded.model,
    Inbox.Message.UpdatedReadStatus({ request, id: first, unread: false }),
  );
  expect(applyOutcome(saved.outMessage).toast.entries).toEqual([]);
  expect(saved.model.entry).toMatchObject({ unread: false });
  const manualRetry = Inbox.update(failed.model, menuAction("toggleUnread"));
  expect(manualRetry.model.readFailed).toBeNull();
  expect(manualRetry.model.readRequests[first]!.userInitiated).toBe(true);
});

it("silently clears an explicit read failure when reopening successfully marks the message read", () => {
  const unreadEntry = { ...mailEntry, unread: true };
  const pending = Inbox.update(
    { ...reader(), entry: unreadEntry, thread: null },
    menuAction("toggleUnread"),
  );
  const failed = Inbox.update(
    pending.model,
    Inbox.Message.ReadStatusFailed({
      request: pending.model.readRequests[first]!.request,
      id: first,
    }),
  );
  const queued = applyOutcome(failed.outMessage);
  const reopened = Inbox.update(
    { ...failed.model, entryRequest: "reopen" },
    Inbox.Message.LoadedEntry({ request: "reopen", entry: unreadEntry }),
  );
  expect(reopened.model.readRequests[first]!.userInitiated).toBe(false);
  const saved = Inbox.update(
    reopened.model,
    Inbox.Message.UpdatedReadStatus({
      request: reopened.model.readRequests[first]!.request,
      id: first,
      unread: false,
    }),
  );
  expect(saved.model.entry).toMatchObject({ unread: false });
  const cleared = applyOutcome(saved.outMessage, queued);
  expect(cleared.keys).toEqual({});
  expect(cleared.toast.entries).toHaveLength(1);
  expect(cleared.toast.entries[0]!.animation.transitionState).toBe(
    "LeaveStart",
  );
});

it("keeps sender priority failures tied to the original sender after navigation and successful retries quiet", () => {
  const pending = Inbox.update(reader(), priorityAction);
  const request = pending.model.senderRuleRequest!.request;
  const failedMessage = Inbox.Message.SenderRuleFailed({ request });
  const savedMessage = Inbox.Message.SenderRuleSaved({ request });
  const navigated = Inbox.update(
    pending.model,
    Inbox.Message.Opened({ folder: "archive", id: second }),
  ).model;
  const failed = Inbox.update(navigated, failedMessage);
  expect(notification(failed.outMessage)).toMatchObject({
    variant: "Error",
    description: "alex@example.com",
  });
  expect(notification(failed.outMessage).title).toContain("priority");
  expect(failed.model.selected).toBe(second);
  expect(Inbox.update(failed.model, failedMessage).outMessage).toBeUndefined();
  expect(Inbox.update(failed.model, savedMessage).outMessage).toBeUndefined();
  expect(Inbox.update(Inbox.initial, failedMessage).outMessage).toBeUndefined();
  expect(Inbox.update(Inbox.initial, savedMessage).outMessage).toBeUndefined();
  const saved = Inbox.update(navigated, savedMessage);
  expect(applyOutcome(saved.outMessage).toast.entries).toEqual([]);
  const queue = applyOutcome(failed.outMessage);
  expect(
    applyOutcome(saved.outMessage, queue).toast.entries[0]?.animation
      .transitionState,
  ).toBe("LeaveStart");
  expect(saved.model.selected).toBe(second);
});

it("tracks independent read-status requests and leaves unrelated errors untouched", () => {
  const firstPending = Inbox.update(reader(), menuAction("toggleUnread")).model;
  const secondPending = Inbox.update(
    {
      ...firstPending,
      active: { id: second, folder: "inbox" },
      entry: { ...mailEntry, id: second, subject: "Other message" },
      thread: null,
    },
    menuAction("toggleUnread"),
  ).model;
  const failedFirst = Inbox.update(
    secondPending,
    Inbox.Message.ReadStatusFailed({
      request: secondPending.readRequests[first]!.request,
      id: first,
    }),
  );
  const failedSecond = Inbox.update(
    failedFirst.model,
    Inbox.Message.ReadStatusFailed({
      request: secondPending.readRequests[second]!.request,
      id: second,
    }),
  );
  const queue = applyOutcome(
    failedSecond.outMessage,
    applyOutcome(failedFirst.outMessage),
  );
  expect(queue.toast.entries).toHaveLength(2);
  expect(notification(failedFirst.outMessage).key).not.toBe(
    notification(failedSecond.outMessage).key,
  );
  expect(notification(failedSecond.outMessage).description).toBe(
    "Other message",
  );
});
