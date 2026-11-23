import { expect, it } from "@effect/vitest";
import { mailPreview } from "./mail-preview.ts";

it("uses HTML link labels without destinations, image URLs, or invisible padding", () => {
  expect(
    mailPreview({
      text: "Plain alternative with link noise https://example.net",
      html: `<p>Hello&nbsp; &nbsp;team.</p><p><a href="https://example.net/${"tracking".repeat(80)}">View the report</a></p><img src="https://example.net/tracker" alt="Tracking pixel"><p>&#8203;&#847;&#8288;Thank you!</p>`,
    }),
  ).toBe("Hello team. View the report Thank you!");
});

it("skips quoted HTML and URL-only links while retaining nearby text", () => {
  expect(
    mailPreview({
      html: '<p>Here is the update.</p><p><a href="https://example.net">https://example.net</a> Ready to review.</p><div class="gmail_quote">Old conversation</div>',
    }),
  ).toBe("Here is the update. Ready to review.");
  expect(mailPreview({ text: "Plain\n\tmail\u00a0preview." })).toBe(
    "Plain mail preview.",
  );
});

it("removes repeated preheader padding before applying the preview limit", () => {
  const padding = "&#847; &zwnj; &nbsp; &#8199; &shy;".repeat(200);
  expect(
    mailPreview({
      html: `<div style="display:none">Your order has shipped!${padding}</div><p>Arriving tomorrow.</p>`,
    }),
  ).toBe("Your order has shipped! Arriving tomorrow.");
  expect(
    mailPreview({
      text:
        "\u200c \u200d\u200c Your order has shipped! " +
        "\u200c\u00a0".repeat(200),
    }),
  ).toBe("Your order has shipped!");
  expect(
    mailPreview({ text: "می\u200cروم 👩\u200d💻 👨\u200d👩\u200d👧\u200d👦" }),
  ).toBe("می\u200cروم 👩\u200d💻 👨\u200d👩\u200d👧\u200d👦");
});
