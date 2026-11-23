import { expect, it } from "@effect/vitest";
import type { Attachment } from "postal-mime";
import { mailHtmlDocument, mailHtmlSandbox } from "../inbox-html.ts";
import { sanitizeMailHtml } from "./mail-html.ts";

const png = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN9sAAAAASUVORK5CYII=",
);
const attachment = (
  contentId: string,
  content = png,
  mimeType = "image/png",
): Attachment => ({
  contentId,
  content,
  mimeType,
  disposition: "inline",
  filename: "image.png",
});

it("preserves email formatting and tables while stripping active content and network styling", () => {
  const html = sanitizeMailHtml(
    `
    <base href="https://tracker.test"><meta http-equiv="refresh" content="0;url=https://tracker.test">
    <link rel="stylesheet" href="https://tracker.test"><style>@import 'https://tracker.test';</style>
    <script>alert(1)</script><iframe srcdoc="evil">evil</iframe>
    <svg><a href="https://tracker.test">evil</a></svg><math><mtext>evil</mtext></math>
    <form action="https://tracker.test"><input name="password"></form>
    <table background="https://tracker.test"><tr><td colspan="2" style="color:#123456;text-align:center;background-image:url(https://tracker.test);position:fixed">
    <strong onclick="alert(1)">Hello</strong><em>world</em><ul><li>One</li></ul>
    </td></tr></table>`,
    [],
  );
  expect(html).toContain(
    '<table><tr><td colspan="2" style="color:#123456;text-align:center">',
  );
  expect(html).toContain(
    "<strong>Hello</strong><em>world</em><ul><li>One</li></ul>",
  );
  expect(html).not.toMatch(
    /tracker|evil|script|iframe|svg|math|form|input|onclick|position|background/iu,
  );
});

it.each([
  "javascript:alert(1)",
  "jav&#x61;script:alert(1)",
  "java&#10;script:alert(1)",
  "data:text/html,evil",
  "//tracker.test",
  "/api/account",
  "#anchor",
  "file:///tmp/file",
])("removes unsafe or app-relative link %s", (href) => {
  const html = sanitizeMailHtml(
    `<a href="${href}" ping="https://tracker.test" target="_top">link</a>`,
    [],
  );
  expect(html).not.toContain("href=");
  expect(html).not.toContain("ping=");
  expect(html).toContain('target="_blank" rel="noopener noreferrer"');
});

it("keeps explicit web and mail links with isolated new-window navigation", () => {
  for (const href of [
    "https://example.net/path",
    "http://example.net/",
    "mailto:person@example.net",
  ]) {
    expect(sanitizeMailHtml(`<a href="${href}">link</a>`, [])).toBe(
      `<a href="${href}" target="_blank" rel="noopener noreferrer">link</a>`,
    );
  }
});

it("resolves encoded CID references using detected raster bytes", () => {
  const html = sanitizeMailHtml(
    '<img src="CID:photo%40mail" onerror="evil()" srcset="https://tracker.test 2x">',
    [attachment("<photo@mail>", png, "application/octet-stream")],
  );
  expect(html).toBe(
    `<img src="data:image/png;base64,${png.toBase64()}" alt="Embedded image" />`,
  );
});

it("blocks remote, relative, sender data URLs, missing CIDs and spoofed images", () => {
  for (const src of [
    "https://tracker.test/pixel",
    "//tracker.test/pixel",
    "/api/account",
    `data:image/png;base64,${png.toBase64()}`,
    "cid:missing",
    "cid:%ZZ",
    "cid:svg",
    "cid:fake",
  ]) {
    const html = sanitizeMailHtml(`<img src="${src}" alt="Photo">`, [
      attachment(
        "<svg>",
        new TextEncoder().encode('<svg onload="evil()"/>'),
        "image/svg+xml",
      ),
      attachment("<fake>", new TextEncoder().encode("not an image")),
    ]);
    expect(html).toBe('<img alt="Photo" />');
  }
});

it("bounds repeated inline image expansion", () => {
  const large = new Uint8Array(1024 * 1024);
  large.set(png);
  const html = sanitizeMailHtml('<img src="cid:large">'.repeat(10), [
    attachment("large", large),
  ]);
  expect(html.length).toBeLessThan(5 * 1024 * 1024 + 1000);
  expect(html.match(/src="data:/gu)).toHaveLength(3);
  expect(html).toContain("Image unavailable");
});

it.each([
  '<xmp><img src=x onerror="evil()"></xmp>',
  '<noscript><p title="</noscript><img src=x onerror=evil()>">',
  '<svg><style><a title="</style><img src=x onerror=evil()>">',
  "<iframe>".repeat(1000),
])("handles malformed and deeply nested hostile markup", (source) => {
  const html = sanitizeMailHtml(source, []);
  expect(html).not.toMatch(
    /<(script|iframe|svg|math|xmp|noscript)\b|\sonerror=|\ssrc=/iu,
  );
});

it("restricts the frame to embedded images and inline styles, with no script or origin privileges", () => {
  const document = mailHtmlDocument(
    sanitizeMailHtml(
      '<meta http-equiv="Content-Security-Policy" content="default-src *"><p>Hello</p>',
      [],
    ),
  );
  expect(document.match(/http-equiv=/gu)).toHaveLength(1);
  expect(document).toContain(
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  );
  expect(mailHtmlSandbox).not.toMatch(
    /allow-scripts|allow-same-origin|allow-forms|allow-top-navigation/u,
  );
});
