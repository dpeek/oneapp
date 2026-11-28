import { expect, it } from "@effect/vitest";
import {
  collapsibleMiddleCount,
  formatMailTimestamp,
  mailBodyPreview,
  splitMailQuote,
} from "./inbox-display.ts";

it("formats timestamps by local calendar day across midnight and a year boundary", () => {
  const morning = new Date(2026, 0, 1, 9, 5).getTime();
  const evening = new Date(2026, 0, 1, 21, 5).getTime();
  expect(formatMailTimestamp(new Date(2026, 0, 1), morning)).toBe("00:00");
  expect(formatMailTimestamp(new Date(morning), evening)).toBe("09:05");
  expect(formatMailTimestamp(new Date(evening), evening)).toBe("21:05");
  expect(formatMailTimestamp(new Date(2025, 11, 31, 23, 59), morning)).toBe(
    "Yesterday",
  );
  expect(formatMailTimestamp(new Date(2025, 11, 31, 0, 1), evening)).toBe(
    "Yesterday",
  );
  expect(formatMailTimestamp(new Date(2025, 11, 30, 23, 59), morning)).toBe(
    "30/12/2025",
  );
});

it("keeps the oldest and newest two messages visible and skips hiding unread or targeted mail", () => {
  const messages = ["first", "second", "third", "fourth", "last"].map((id) => ({
    id,
  }));
  expect(collapsibleMiddleCount(messages.slice(0, 3), [])).toBe(0);
  expect(collapsibleMiddleCount(messages.slice(0, 4), [])).toBe(1);
  expect(collapsibleMiddleCount(messages, ["first", "last"])).toBe(2);
  expect(collapsibleMiddleCount(messages, ["third"])).toBe(0);
  expect(
    collapsibleMiddleCount(
      [messages[0]!, { id: "unread", unread: true }, ...messages.slice(2)],
      [],
    ),
  ).toBe(0);
});

it("folds reply quotes with their attribution and preserves interleaved answers", () => {
  const text = [
    "Here are the updates.",
    "",
    "On Tuesday, 17 November, Alice",
    "<alice@example.net> wrote:",
    "> Can you check it?",
    "",
    "Yes, and 2 > 1.",
    "",
    "> And this?",
    "",
    "Also done.",
  ].join("\r\n");
  expect(splitMailQuote(text)).toEqual([
    { quoted: false, text: "Here are the updates." },
    {
      quoted: true,
      text: "On Tuesday, 17 November, Alice\n<alice@example.net> wrote:\nCan you check it?",
    },
    { quoted: false, text: "Yes, and 2 > 1." },
    { quoted: true, text: "And this?" },
    { quoted: false, text: "Also done." },
  ]);
});

it("folds the original Outlook message when it has no quote prefixes", () => {
  const text =
    "I'm following up.\n\nFrom: Alice\nSent: Tuesday\nTo: Bob\nSubject: Planning\n\nEarlier email.";
  expect(splitMailQuote(text)).toEqual([
    { quoted: false, text: "I'm following up." },
    {
      quoted: true,
      text: "From: Alice\nSent: Tuesday\nTo: Bob\nSubject: Planning\n\nEarlier email.",
    },
  ]);
});

it("flattens a mail preview and skips reply quotes without splitting Unicode characters", () => {
  expect(
    mailBodyPreview(
      "Hi\r\nthere\n\nOn Friday, Alice wrote:\n> Old text\n\nSee\t you soon.",
    ),
  ).toBe("Hi there See you soon.");
  expect(mailBodyPreview("> Quoted message only")).toBe("");
  expect(mailBodyPreview("📨".repeat(200))).toBe("📨".repeat(200));
  expect(mailBodyPreview("📨".repeat(201))).toBe("📨".repeat(199) + "…");
});

it("normalizes invisible email padding and omits noisy URLs in previews", () => {
  expect(
    mailBodyPreview(
      "  Hello\u00a0\u00a0\u200b\u034f\u2060there\t\n  team.\nDetails [https://example.net/track?token=abc] (https://example.net) <https://example.net> www.example.net/path\nThanks!  ",
    ),
  ).toBe("Hello there team. Details Thanks!");
  expect(mailBodyPreview("👩‍💻 A soft\u00adhyphen.")).toBe("👩‍💻 A softhyphen.");
});
