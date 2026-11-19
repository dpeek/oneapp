import { expect, it } from "@effect/vitest";
import { splitMailQuote } from "./inbox-display.ts";

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
