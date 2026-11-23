import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
vi.mock("@oneapp/ui", async () => ({
  Toast: await import("../../../packages/ui/src/toast-state.ts"),
}));
import * as People from "./people.ts";
import * as Clients from "./connected-clients.ts";
import * as Notifications from "./notifications.ts";

const person = {
  id: "00000000-0000-4000-8000-000000000001",
  revision: "00000000-0000-4000-8000-000000000003",
  name: "Alex",
  self: false,
  photo: null,
  addresses: ["alex@example.com"],
  managedAddresses: [],
};
const other = {
  ...person,
  id: "00000000-0000-4000-8000-000000000002",
  name: "Sam",
};
const connection = {
  type: "CLI" as const,
  id: "device-one",
  name: "Work laptop",
  createdAt: 1,
};
const clients = () => ({
  ...Clients.initial,
  connections: [connection, { ...connection, type: "MCP" as const }],
});
const edit = () => {
  const opened = People.update(
    {
      ...People.initial,
      directory: {
        ...People.initial.directory,
        selected: person.id,
        records: [person, other],
      },
    },
    People.Message.EditedRecord(),
  );
  return People.update(opened.model, People.Message.SubmittedEdit());
};
const revoke = () =>
  Clients.update(clients(), Clients.Message.RequestedRevocation(connection));
const applyOutcome = (
  out: People.OutMessage | Clients.OutMessage | undefined,
  model = Notifications.init(),
) => {
  if (out?._tag === "Notify")
    return Notifications.show(model, out.notification);
  if (out?._tag === "DismissNotification")
    return Notifications.dismiss(model, out.key);
  throw new Error("Expected notification outcome");
};

it("keeps contact validation/save failures beside the visible editor with no toast", () => {
  const pending = edit();
  const failed = People.update(
    pending.model,
    People.Message.Failed({
      request: pending.model.directory.editRequest!,
      error: "Enter a valid email address.",
    }),
  );
  expect(failed.model.directory.editError).toBe("Enter a valid email address.");
  expect(failed.model.directory.edit).toEqual(person);
  expect(failed.model.directory.editRequest).toBeNull();
  expect(applyOutcome(failed.outMessage).model.toast.entries).toEqual([]);
});

it.each(["other-contact", "other-page"])(
  "reports a contact save failure only when its editor is hidden: %s",
  (destination) => {
    const pending = edit();
    const request = pending.model.directory.editRequest!;
    const navigated =
      destination === "other-contact"
        ? People.update(
            pending.model,
            People.Message.VisitedDirectory({ id: other.id, refresh: false }),
          ).model
        : pending.model;
    const failed = People.update(
      navigated,
      People.Message.Failed({ request, error: "Could not save." }),
      destination !== "other-page",
    );
    expect(failed.model.directory.editError).toBeNull();
    expect(failed.model.directory.editTarget).toBeNull();
    const toast = applyOutcome(failed.outMessage).model.toast.entries[0]!;
    expect(toast.payload).toMatchObject({
      variant: "Error",
      description: "Alex",
    });
    expect(toast.payload.title).toContain("Reopen it in Contacts");
    expect(
      People.update(
        failed.model,
        People.Message.Failed({ request, error: "Late" }),
        false,
      ).outMessage,
    ).toBeUndefined();
  },
);

it("keeps profile dialog errors inline even outside Contacts and prevents closing during save", () => {
  const opened = {
    ...People.initial,
    opened: true,
    ready: true,
    person,
    saveRequest: "save",
  };
  expect(People.update(opened, People.Message.Closed()).model).toBe(opened);
  const failed = People.update(
    opened,
    People.Message.Failed({
      request: "save",
      error: "Could not save the profile.",
    }),
    false,
  );
  expect(failed.model).toMatchObject({
    opened: true,
    person,
    error: "Could not save the profile.",
    saveRequest: null,
  });
  expect(applyOutcome(failed.outMessage).model.toast.entries).toEqual([]);
});

it("silently clears an earlier hidden contact error after retry, rejects mismatched saves and ignores old sessions", () => {
  const pending = edit();
  const request = pending.model.directory.editRequest!;
  const failed = People.update(
    pending.model,
    People.Message.Failed({ request, error: "Could not save." }),
    false,
  );
  const queue = applyOutcome(failed.outMessage).model;
  const retry = People.update(failed.model, People.Message.SubmittedEdit());
  const savedMessage = People.Message.Saved({
    request: retry.model.directory.editRequest!,
    person: { ...person, name: "Alex updated" },
  });
  const saved = People.update(retry.model, savedMessage);
  expect(
    saved.model.directory.records?.find((item) => item.id === person.id)?.name,
  ).toBe("Alex updated");
  expect(applyOutcome(saved.outMessage).model.toast.entries).toEqual([]);
  expect(
    applyOutcome(saved.outMessage, queue).model.toast.entries[0]?.animation
      .transitionState,
  ).toBe("LeaveStart");
  expect(
    People.update(
      retry.model,
      People.Message.Saved({
        request: retry.model.directory.editRequest!,
        person: other,
      }),
    ).model,
  ).toBe(retry.model);
  expect(
    People.update(People.initial, savedMessage).outMessage,
  ).toBeUndefined();
  expect(People.update(saved.model, savedMessage).outMessage).toBeUndefined();
  const inline = People.update(
    retry.model,
    People.Message.Failed({
      request: retry.model.directory.editRequest!,
      error: "Invalid address.",
    }),
  );
  expect(
    applyOutcome(inline.outMessage, queue).model.toast.entries[0]?.animation
      .transitionState,
  ).toBe("LeaveStart");
});

it.each([true, false])(
  "keeps revocation failure inline only while Clients is visible: %s",
  (visible) => {
    const pending = revoke();
    const message = Clients.Message.Failed({
      request: pending.model.request!.id,
      error: "Could not revoke CLI access. Try again.",
    });
    const failed = Clients.update(pending.model, message, visible);
    expect(failed.model.connections).toEqual(clients().connections);
    expect(failed.model.error).toBe(visible ? message.error : "");
    expect(failed.model.request).toBeNull();
    const queue = applyOutcome(failed.outMessage).model;
    if (visible) expect(queue.toast.entries).toEqual([]);
    else
      expect(queue.toast.entries[0]?.payload).toMatchObject({
        variant: "Error",
        description: "Work laptop",
      });
    expect(
      Clients.update(failed.model, message, false).outMessage,
    ).toBeUndefined();
  },
);

it("silently clears revocation errors after success and only removes the matching client type/id", () => {
  const pending = revoke();
  const failed = Clients.update(
    pending.model,
    Clients.Message.Failed({
      request: pending.model.request!.id,
      error: "Could not revoke.",
    }),
    false,
  );
  const queue = applyOutcome(failed.outMessage).model;
  const retry = Clients.update(
    failed.model,
    Clients.Message.RequestedRevocation(connection),
  );
  const request = retry.model.request!.id;
  expect(
    Clients.update(
      retry.model,
      Clients.Message.Revoked({ ...connection, type: "MCP", request }),
    ).model,
  ).toBe(retry.model);
  const revoked = Clients.update(
    retry.model,
    Clients.Message.Revoked({ ...connection, request }),
  );
  expect(revoked.model.connections).toEqual([{ ...connection, type: "MCP" }]);
  expect(applyOutcome(revoked.outMessage).model.toast.entries).toEqual([]);
  expect(
    applyOutcome(revoked.outMessage, queue).model.toast.entries[0]?.animation
      .transitionState,
  ).toBe("LeaveStart");
  const inline = Clients.update(
    retry.model,
    Clients.Message.Failed({ request, error: "Still failed." }),
  );
  expect(
    applyOutcome(inline.outMessage, queue).model.toast.entries[0]?.animation
      .transitionState,
  ).toBe("LeaveStart");
});

it("ignores stale client completions and session expiry after reset or a newer request", () => {
  const pending = revoke();
  const request = pending.model.request!.id;
  for (const state of [Clients.initial, revoke().model]) {
    for (const message of [
      Clients.Message.Revoked({ ...connection, request }),
      Clients.Message.Failed({ request, error: "Old" }),
      Clients.Message.SessionExpired({ request }),
      Clients.Message.Loaded({ request, connections: [], unavailable: [] }),
    ]) {
      expect(Clients.update(state, message)).toEqual({ model: state });
    }
  }
  expect(
    Clients.update(pending.model, Clients.Message.SessionExpired({ request }))
      .outMessage?._tag,
  ).toBe("SessionExpired");
  expect(
    Clients.update(
      pending.model,
      Clients.Message.RequestedRevocation(connection),
    ).model,
  ).toBe(pending.model);
  expect(
    Clients.update(
      clients(),
      Clients.Message.RequestedRevocation({ ...connection, id: "missing" }),
    ).commands,
  ).toBeUndefined();
});

it("keeps partial client loading failures contextual, preserving unavailable client types", () => {
  const pending = Clients.update(clients(), Clients.Message.Requested());
  const loaded = Clients.update(
    pending.model,
    Clients.Message.Loaded({
      request: pending.model.request!.id,
      connections: [],
      unavailable: ["CLI"],
    }),
  );
  expect(loaded.model.connections).toEqual([connection]);
  expect(loaded.model.unavailable).toEqual(["CLI"]);
  expect(loaded.outMessage).toBeUndefined();
  expect(
    Clients.update(loaded.model, Clients.Message.Requested()).commands,
  ).toHaveLength(1);
  expect(
    Clients.update(
      Clients.initial,
      Clients.Message.Loaded({
        request: pending.model.request!.id,
        connections: [connection],
        unavailable: [],
      }),
    ).model,
  ).toBe(Clients.initial);
});
