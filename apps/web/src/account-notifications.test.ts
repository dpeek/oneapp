import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { PendingEmailChange } from "./account-contract.ts";
import { vi } from "vitest";
vi.mock("@oneapp/ui", async () => ({
  Toast: await import("../../../packages/ui/src/toast-state.ts"),
}));
import * as Account from "./account-settings.ts";
import * as Notifications from "./notifications.ts";

const pending: typeof Account.Model.Type = {
  ...Account.initial,
  pending: "send",
  request: "request-one",
};
const error = Account.Message.Failed({
  error: "Rejected user input: PRIVATE-TEST-VALUE",
});

it("keeps visible account failures inline and makes hidden failures generic", () => {
  const visible = Account.feedback(pending, error, true);
  expect(visible).toEqual(
    Account.OutMessage.DismissNotification({ key: Account.notificationKey }),
  );
  const hidden = Account.feedback(pending, error, false);
  expect(hidden?._tag).toBe("Notify");
  if (hidden?._tag !== "Notify") throw new Error("Expected feedback");
  const notifications = Notifications.show(
    Notifications.init(),
    hidden.notification,
  ).model;
  expect(notifications.toast.entries[0]?.payload.variant).toBe("Error");
  expect(notifications.toast.entries[0]?.payload.title).toContain(
    "Return to Settings",
  );
  expect(JSON.stringify(notifications)).not.toContain("PRIVATE-TEST-VALUE");
  expect(
    Notifications.dismiss(notifications, Account.notificationKey).model.toast
      .entries[0]?.animation.transitionState,
  ).toBe("LeaveStart");
});

it("keeps verification instructions and successful account changes out of success toasts", () => {
  for (const message of [
    Account.Message.CodeSent({ verification: null }),
    Account.Message.EmailVerified(),
    Account.Message.EmailChangeStarted({
      change: Schema.decodeUnknownSync(PendingEmailChange)({
        id: "00000000-0000-4000-8000-000000000001",
        email: "new@example.com",
      }),
    }),
  ]) {
    for (const visible of [true, false]) {
      expect(Account.feedback(pending, message, visible)).toEqual(
        Account.OutMessage.DismissNotification({
          key: Account.notificationKey,
        }),
      );
    }
  }
  for (const message of [
    Account.Message.PasswordChanged(),
    Account.Message.EmailChanged({ oldAddressNotified: false }),
    Account.Message.SignedOut(),
  ]) {
    expect(Account.feedback(pending, message, false)).toBeUndefined();
  }
});

it("does not notify for idle, dialog, or submission messages", () => {
  expect(Account.feedback(Account.initial, error, false)).toBeUndefined();
  for (const message of [
    Account.Message.SendCode(),
    Account.Message.CloseDialog(),
    Account.Message.DialogUpdated(),
    Account.Message.OpenDialog({ dialog: "password" }),
  ])
    expect(Account.feedback(pending, message, false)).toBeUndefined();
});
