import { expect, it } from "@effect/vitest";
import { inboxComposeLimits } from "../inbox-contract.ts";
import { prepareMailBody } from "./mail-authoring.ts";

it("retains existing plain-text mail exactly", () => {
  const body = { text: "Hi\n\n> Quoted message\n" };
  expect(prepareMailBody(body)).toEqual(body);
});

it("generates matching plain text with lists and link destinations", () => {
  const body = prepareMailBody({
    text: "Untrusted mismatch",
    html: '<p>Hello <strong>team</strong>, <em>thanks</em>!</p><ul><li>First</li><li>Second</li></ul><ol><li>One</li></ol><p><a href="https://example.net">Details</a></p>',
  });
  expect(body?.text).toContain("Hello team, thanks!");
  expect(body?.text).toContain("First");
  expect(body?.text).toContain("Second");
  expect(body?.text).toMatch(/1\. One/u);
  expect(body?.text).toContain("https://example.net");
  expect(body?.text).not.toContain("Untrusted mismatch");
  expect(body?.html).toContain("<strong>team</strong>");
});

it("strips active markup, style, tracking images, and unsafe authoring links", () => {
  const body = prepareMailBody({
    text: "Hello",
    html: '<p style="background:url(https://tracker.test)" onclick="evil()">Hello</p><script>evil()</script><img src="https://tracker.test"><iframe src="https://tracker.test">evil</iframe><a href="jav&#x61;script:evil()">bad</a><a href="/api/account">relative</a>',
  });
  expect(body?.html).toBe("<p>Hello</p><a>bad</a><a>relative</a>");
  expect(body?.text).not.toMatch(/evil|tracker|api\/account/u);
});

it("rejects empty sanitized bodies and plain-text expansion beyond the limit", () => {
  expect(
    prepareMailBody({
      text: "placeholder",
      html: '<img src="https://tracker.test"><script>evil()</script>',
    }),
  ).toBeNull();
  expect(
    prepareMailBody({
      text: "x",
      html: `<p>${"x".repeat(inboxComposeLimits.text + 1)}</p>`,
    }),
  ).toBeNull();
  expect(
    prepareMailBody({
      text: "x",
      html: `<a href="https://example.net/${"x".repeat(inboxComposeLimits.text)}">x</a>`,
    }),
  ).toBeNull();
});

it("builds reply-all with Reply-To, To and Cc, removing duplicates and our addresses", async () => {
  const { default: PostalMime } = await import("postal-mime");
  const { replyAllRecipients } = await import("./mail-reply.ts");
  const mail = await PostalMime.parse(
    [
      "From: sender@example.net",
      "Reply-To: desk@example.net, Other <other@example.net>",
      "To: Owner <owner@example.net>, DESK@example.net, team@example.net",
      "Cc: TEAM@example.net, colleague@example.net, alias@example.net",
      "Bcc: private@example.net",
      "",
      "Hello",
    ].join("\r\n"),
  );
  expect(
    replyAllRecipients(mail, "bounce@example.net", [
      "OWNER@example.net",
      "alias@example.net",
    ]),
  ).toEqual({
    allTo: "desk@example.net, other@example.net, team@example.net",
    cc: "colleague@example.net",
  });
  expect(
    replyAllRecipients(null, "sender@example.net", ["owner@example.net"]),
  ).toEqual({ allTo: "sender@example.net", cc: "" });
});
