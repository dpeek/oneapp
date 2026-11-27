import { describe, expect, it } from "@effect/vitest";
import {
  commitText,
  init,
  overlay,
  settled,
  stage,
  type Draft,
} from "./task-edits.ts";
import { taskDescriptionLimit, type Task } from "./tasks-contract.ts";

const task: Task = {
  id: "task",
  revision: "original",
  title: "Saved task",
  description: "## Markdown",
  status: "not-started",
  priority: null,
  assignee: null,
  author: "owner",
  dueOn: null,
  tagIds: [],
  createdAt: 0,
  updatedAt: 0,
  latestRun: null,
};

describe("task edit drafts", () => {
  it("keeps a newer value when an earlier write settles", () => {
    const flight = { request: "first", patch: { priority: "high" } } as const;
    const draft = stage(
      task,
      { ...init(task), flight },
      {
        priority: null,
        description: "**Next**\n\nParagraph",
      },
    );
    const saved = { ...task, ...flight.patch, revision: "first" };
    const next = settled(saved, draft, null);

    expect(next.revision).toBe("first");
    expect(next.flight).toBeNull();
    expect(next.pending).toEqual({
      priority: null,
      description: "**Next**\n\nParagraph",
    });
    expect(overlay(saved, next).priority).toBeNull();
  });

  it("keeps attempted fields on failure and gives newer edits precedence", () => {
    const flight = {
      request: "first",
      patch: { title: "Earlier title", priority: "urgent" },
    } as const;
    const draft = stage(
      task,
      { ...init(task), flight },
      { title: "Later title" },
    );

    for (const error of ["failed", "conflict"] as const) {
      const latest = { ...task, assignee: "oru", revision: "remote" } as const;
      const next = settled(latest, draft, error);
      expect(next.error).toBe(error);
      expect(next.revision).toBe(task.revision);
      expect(next.pending).toEqual({
        title: "Later title",
        priority: "urgent",
      });
      expect(overlay(latest, next).assignee).toBe("oru");
    }
  });

  it("retains an oversized description and stages it only after correction", () => {
    const value = "x".repeat(taskDescriptionLimit + 1);
    const draft: Draft = {
      ...init(task),
      pending: { description: "Earlier edit", priority: "high" },
      text: { description: { value, timer: null } },
    };
    const invalid = commitText(task, draft, "description", true);
    expect(invalid.text.description?.value).toBe(value);
    expect(invalid.pending).toEqual({ priority: "high" });
    const corrected = value.slice(1);
    const valid = commitText(
      task,
      {
        ...invalid,
        text: { description: { value: corrected, timer: "next" } },
      },
      "description",
      false,
    );
    expect(valid.text.description).toBeUndefined();
    expect(valid.pending.description).toBe(corrected);
  });

  it("trims committed titles and keeps a blank draft out of other writes", () => {
    const draft: Draft = {
      ...init(task),
      text: {
        title: { value: "  ", timer: null },
        description: { value: "Line\n", timer: "d" },
      },
    };
    const next = commitText(
      task,
      commitText(task, draft, "title", true),
      "description",
      true,
    );
    expect(next.text.title?.value).toBe("  ");
    expect(next.pending).toEqual({ description: "Line\n" });
    expect(overlay(task, next).title).toBe("Saved task");

    const edited = {
      ...next,
      text: { title: { value: " Edited ", timer: "t" } },
    };
    const debounced = commitText(task, edited, "title", false);
    expect(debounced.pending.title).toBe("Edited");
    expect(debounced.text.title?.value).toBe(" Edited ");
    expect(
      commitText(task, debounced, "title", true).text.title,
    ).toBeUndefined();
  });
});
