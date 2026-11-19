import { expect, it } from "@effect/vitest";
import { collapsibleMiddleCount, splitMailQuote } from "./inbox-display.ts";

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
