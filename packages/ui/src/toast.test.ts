import { expect, it } from "@effect/vitest";
import { Animation } from "@foldkit/ui";
import { Duration, Option, Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import * as Toast from "./toast-state.ts";
import * as Focus from "./toast-focus.ts";

const initial = () => Toast.init({ id: "notifications" });
const entry = (model: Toast.Model, id?: string) =>
  id === undefined
    ? model.entries.at(-1)!
    : model.entries.find((item) => item.id === id)!;
const settle = (model: Toast.Model, id: string) => {
  const generation = entry(model, id).animation.transitionGeneration;
  const painted = Toast.update(
    model,
    Toast.Message.GotAnimationMessage({
      entryId: id,
      message: Animation.Message.CompletedWaitForPaint({ generation }),
    }),
  );
  return Toast.update(
    painted.model,
    Toast.Message.GotAnimationMessage({
      entryId: id,
      message: Animation.Message.EndedAnimation({ generation }),
    }),
  );
};
const focus = (model: Toast.Model, focused: boolean) =>
  Toast.update(
    model,
    Toast.Message.ChangedToastViewportFocus({
      position: "bottom-right",
      fallbackPosition: "bottom-right",
      focused,
    }),
  );
const hover = (model: Toast.Model, hovered: boolean) =>
  Toast.update(
    model,
    Toast.Message.ChangedToastViewportPointer({
      position: "bottom-right",
      fallbackPosition: "bottom-right",
      hovered,
      pause: true,
    }),
  );

it("applies Orumai timing and persistence defaults, with explicit overrides", () => {
  const model = initial();
  expect(model.position).toBe("bottom-right");
  expect(model.limit).toBe(3);
  const success = Toast.show(model, Toast.success({ title: "Saved." }));
  expect(
    Duration.toMillis(Option.getOrThrow(entry(success.model).maybeDuration)),
  ).toBe(4000);
  for (const input of [
    Toast.error({ title: "Could not save." }),
    Toast.warning({ title: "Sent without saving a copy." }),
    Toast.success({ title: "Deleted.", actionLabel: "Undo" }),
  ]) {
    expect(
      Option.isNone(entry(Toast.show(model, input).model).maybeDuration),
    ).toBe(true);
  }
  const timedError = Toast.show(
    model,
    Toast.error({
      title: "Could not copy.",
      sticky: false,
      duration: "8 seconds",
    }),
  );
  expect(
    Duration.toMillis(Option.getOrThrow(entry(timedError.model).maybeDuration)),
  ).toBe(8000);
});

it("removes a timed toast after its lifecycle and reports the exact entry", () => {
  let model = Toast.show(initial(), Toast.success({ title: "Saved." })).model;
  const id = entry(model).id;
  model = settle(model, id).model;
  model = Toast.update(
    model,
    Toast.Message.CompletedWaitBeforeDismissal({
      entryId: id,
      version: entry(model).pendingDismissVersion,
    }),
  ).model;
  const result = settle(model, id);
  expect(result.model.entries).toHaveLength(0);
  expect(result.outMessage).toMatchObject({
    _tag: "DismissedToast",
    entry: { id },
  });
});

it("pauses for hover and focus independently and rejects obsolete timers", () => {
  let model = Toast.show(initial(), Toast.success({ title: "Saved." })).model;
  const id = entry(model).id;
  model = settle(model, id).model;
  const version = entry(model).pendingDismissVersion;
  model = hover(model, true).model;
  model = focus(model, true).model;
  model = hover(model, false).model;
  expect(entry(model).isHovered).toBe(true);
  const duringFocus = Toast.update(
    model,
    Toast.Message.CompletedWaitBeforeDismissal({ entryId: id, version }),
  );
  expect(duringFocus.model).toBe(model);
  const resumed = focus(model, false);
  expect(entry(resumed.model).isHovered).toBe(false);
  expect(resumed.commands?.length).toBeGreaterThan(0);
  expect(entry(resumed.model).pendingDismissVersion).toBeGreaterThan(version);
  const stale = Toast.update(
    resumed.model,
    Toast.Message.CompletedWaitBeforeDismissal({ entryId: id, version }),
  );
  expect(entry(stale.model).animation.transitionState).toBe("Idle");
});

it("queues excess notifications without expiring them, then promotes them", () => {
  let model = initial();
  for (let index = 0; index < 4; index++) {
    model = Toast.show(
      model,
      Toast.success({ title: `Saved ${index}.` }),
    ).model;
    model = settle(model, entry(model).id).model;
  }
  const oldest = model.entries[0]!;
  expect(Toast.visibleEntries(model)).toHaveLength(3);
  expect(model.limitedIds).toEqual([oldest.id]);
  expect(oldest.isHovered).toBe(true);
  expect(
    Toast.update(
      model,
      Toast.Message.CompletedWaitBeforeDismissal({
        entryId: oldest.id,
        version: oldest.pendingDismissVersion,
      }),
    ).model,
  ).toBe(model);
  const newest = entry(model).id;
  model = Toast.dismiss(model, newest).model;
  const removed = settle(model, newest);
  expect(removed.model.limitedIds).toEqual([]);
  expect(entry(removed.model, oldest.id).isHovered).toBe(false);
  expect(entry(removed.model, oldest.id).pendingDismissVersion).toBeGreaterThan(
    oldest.pendingDismissVersion,
  );
});

it("routes actions through the parent schema exactly once and keeps duplicate titles distinct", () => {
  const Parent = defineMessageUnion({ GotToast: { message: Toast.Message } });
  let model = Toast.show(
    initial(),
    Toast.success({ title: "Deleted.", actionLabel: "Undo" }),
  ).model;
  const first = entry(model).id;
  model = Toast.show(
    model,
    Toast.success({ title: "Deleted.", actionLabel: "Undo" }),
  ).model;
  const second = entry(model).id;
  const message = Parent.GotToast({
    message: Toast.Message.ActivatedToastAction({ id: first }),
  });
  const decoded = Schema.decodeUnknownSync(Parent)(message);
  const result = Toast.update(model, decoded.message);
  expect(result.outMessage).toMatchObject({
    _tag: "ActivatedToast",
    entry: { id: first },
  });
  expect(entry(result.model, second).animation.isShowing).toBe(true);
  expect(
    Toast.update(result.model, decoded.message).outMessage,
  ).toBeUndefined();
  expect(settle(result.model, first).outMessage).toMatchObject({
    _tag: "DismissedToast",
    entry: { id: first },
  });
});

it("ignores missing, hidden, and non-actionable action targets", () => {
  let model = Toast.show(
    initial(),
    Toast.success({ title: "Deleted.", actionLabel: "Undo" }),
  ).model;
  const queued = entry(model).id;
  for (let index = 0; index < 3; index++)
    model = Toast.show(model, Toast.info({ title: "Updated." })).model;
  for (const id of ["missing", queued, entry(model).id]) {
    expect(
      Toast.update(model, Toast.Message.ActivatedToastAction({ id }))
        .outMessage,
    ).toBeUndefined();
  }
});

it("updates persistence and timers without losing a focus pause or reviving a dismissed toast", () => {
  let model = Toast.show(
    initial(),
    Toast.info({ title: "Exporting…", sticky: true }),
  ).model;
  const id = entry(model).id;
  model = focus(model, true).model;
  model = Toast.updateToast(
    model,
    id,
    Toast.success({ title: "Export ready." }),
  ).model;
  expect(Option.isSome(entry(model).maybeDuration)).toBe(true);
  expect(entry(model).isHovered).toBe(true);
  model = Toast.updateToast(
    model,
    id,
    Toast.error({ title: "Export failed." }),
  ).model;
  expect(Option.isNone(entry(model).maybeDuration)).toBe(true);
  model = Toast.updateToast(model, id, {
    sticky: false,
    duration: "10 seconds",
  }).model;
  expect(Duration.toMillis(Option.getOrThrow(entry(model).maybeDuration))).toBe(
    10000,
  );
  model = Toast.dismiss(model, id).model;
  expect(Toast.updateToast(model, id, { title: "Late completion" }).model).toBe(
    model,
  );
});

it("expands measured cards without overlap and hides queued cards", () => {
  let model = initial();
  for (const height of [60, 100, 80, 120]) {
    model = Toast.show(model, Toast.info({ title: "Updated." })).model;
    model = settle(model, entry(model).id).model;
    model = Toast.update(
      model,
      Toast.Message.MeasuredToast({ entryId: entry(model).id, height }),
    ).model;
  }
  const collapsed = Toast.stackLayout(model, "bottom-right", false);
  expect(collapsed.height).toBe(144);
  const expanded = Toast.stackLayout(model, "bottom-right", true);
  expect(expanded.height).toBe(324);
  expect(
    expanded.entries
      .filter((item) => !item.limited)
      .map((item) => item.style["--toast-offset-y"]),
  ).toEqual(["0px", "132px", "224px"]);
  expect(expanded.entries.at(-1)?.style.opacity).toBe("0");
});

it("dismisses with a completed swipe but restores a cancelled drag", () => {
  let model = Toast.show(initial(), Toast.success({ title: "Saved." })).model;
  const id = entry(model).id;
  model = settle(model, id).model;
  model = Toast.update(
    model,
    Toast.Message.PressedEntryPointer({
      entryId: id,
      pointerId: 1,
      clientX: 0,
    }),
  ).model;
  model = Toast.update(
    model,
    Toast.Message.MovedSwipePointer({ pointerId: 1, clientX: 100 }),
  ).model;
  model = Toast.update(model, Toast.Message.PressedEscape()).model;
  expect(entry(model).animation.isShowing).toBe(true);
  model = Toast.update(
    model,
    Toast.Message.PressedEntryPointer({
      entryId: id,
      pointerId: 2,
      clientX: 0,
    }),
  ).model;
  model = Toast.update(
    model,
    Toast.Message.ReleasedSwipePointer({ pointerId: 2, clientX: 200 }),
  ).model;
  expect(entry(model).animation.transitionState).toBe("LeaveStart");
});

it("recovers focus to the next surviving action, then to the viewport", () => {
  const config = {
    itemId: Toast.focusTargetId,
    fallbackId: "notifications-viewport",
  };
  let model = Focus.updateCollection(
    Focus.initCollection(),
    Focus.CollectionMessage.ReconciledItems({
      keys: ["a", "b"],
      enabledKeys: ["a", "b"],
    }),
    config,
  ).model;
  model = Focus.updateCollection(
    model,
    Focus.CollectionMessage.FocusedItem({ key: "a" }),
    config,
  ).model;
  const next = Focus.updateCollection(
    model,
    Focus.CollectionMessage.ReconciledItems({
      keys: ["b"],
      enabledKeys: ["b"],
    }),
    config,
  );
  expect(next.commands?.[0]?.args).toEqual({
    lostId: "a",
    targetId: "b-focus",
  });
  const empty = Focus.updateCollection(
    next.model,
    Focus.CollectionMessage.ReconciledItems({ keys: [], enabledKeys: [] }),
    config,
  );
  expect(empty.commands?.[0]?.args).toEqual({
    lostId: "b",
    targetId: "notifications-viewport",
  });
  const blurred = Focus.updateCollection(
    next.model,
    Focus.CollectionMessage.BlurredItems(),
    config,
  ).model;
  expect(
    Focus.updateCollection(
      blurred,
      Focus.CollectionMessage.ReconciledItems({ keys: [], enabledKeys: [] }),
      config,
    ).commands,
  ).toEqual([]);
});
