import { expect, it } from "@effect/vitest";
import type { Attachment } from "postal-mime";
import { mailHtmlDocument, mailHtmlSandbox } from "../inbox-html.ts";
import { mailImagePlaceholder, sanitizeMailHtml } from "./mail-html.ts";

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
    expect(html).toContain(`src="${mailImagePlaceholder}"`);
    expect(html).toContain('alt="Photo"');
    expect(html).not.toContain('src="' + src + '"');
  }
});

it("bounds repeated inline image expansion", () => {
  const large = new Uint8Array(1024 * 1024);
  large.set(png);
  const html = sanitizeMailHtml('<img src="cid:large">'.repeat(10), [
    attachment("large", large),
  ]);
  expect(html.length).toBeLessThan(5 * 1024 * 1024 + 1000);
  expect(html.match(/src="data:image\/png/gu)).toHaveLength(3);
  expect(html.split(mailImagePlaceholder)).toHaveLength(8);
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

it("keeps receipt table alignment, backgrounds, spacing and typography", () => {
  // Representative receipt structure, with synthetic content rather than customer data.
  const html = sanitizeMailHtml(
    `
    <table width="100%" bgcolor="#f6f9fc" cellpadding="0" cellspacing="0">
      <tr><td><table align="center" width="600" bgcolor="#ffffff"
        style="margin:0 auto;min-width:600px;border-radius:16px">
        <tr><td style="font-family:-apple-system, 'Helvetica Neue', sans-serif;font-size:24px;line-height:32px;text-align:center">Receipt</td></tr>
        <tr><td style="padding:16px 24px;white-space:nowrap;text-transform:uppercase;line-height:16px">Amount paid</td></tr>
        <tr bgcolor="#f6f9fc"><td style="border-top:1px solid #e6ebf1;border-radius:8px;vertical-align:text-bottom">$12.00</td></tr>
        <tr><td style="height:16px;max-height:16px;font-size:1px;line-height:1px">&nbsp;</td></tr>
      </table></td></tr>
    </table>`,
    [],
  );
  expect(html).toContain('align="center" width="600" bgcolor="#ffffff"');
  for (const style of [
    "margin:0 auto",
    "min-width:600px",
    "border-radius:16px",
    "font-family:-apple-system, 'Helvetica Neue', sans-serif",
    "line-height:32px",
    "padding:16px 24px",
    "white-space:nowrap",
    "text-transform:uppercase",
    "border-top:1px solid #e6ebf1",
    "vertical-align:text-bottom",
    "height:16px",
  ])
    expect(html).toContain(style);
  expect(html).toContain('<tr bgcolor="#f6f9fc">');
});

it("keeps preheaders hidden while preserving the following visible content", () => {
  const html = sanitizeMailHtml(
    `
    <table><tr><td style="display:none!important;max-height:0;max-width:0;opacity:0;overflow:hidden;visibility:hidden;font-size:1px;line-height:1px">Inbox preview only</td></tr>
    <tr><td style="display:table-cell">Visible receipt</td></tr></table>
    <div hidden>Hidden preview</div>`,
    [],
  );
  expect(html).toContain("display:none !important");
  expect(html).toContain(
    "max-height:0;max-width:0;opacity:0;overflow:hidden;visibility:hidden",
  );
  expect(html).toContain('<td style="display:table-cell">Visible receipt</td>');
  expect(html).toContain("<div hidden>Hidden preview</div>");
});

it("rejects CSS network requests, executable values and positioning in presentation styles", () => {
  const html = sanitizeMailHtml(
    `
    <style>@font-face{font-family:evil;src:url(https://tracker.test/font)}</style>
    <p style="font-family:url(https://tracker.test/font);line-height:expression(alert(1));margin:var(--remote);padding:calc(1px + 2px);border:1px solid url(https://tracker.test);border-image:url(https://tracker.test);background:url(https://tracker.test);background-image:image-set(url(https://tracker.test) 1x);list-style-image:url(https://tracker.test);cursor:url(https://tracker.test),auto;position:fixed;inset:0;z-index:9999;filter:url(https://tracker.test);behavior:url(evil.htc);-moz-binding:url(https://tracker.test)">Visible text</p>
    <img style="display:block;width:96px !important;height:auto;border:0" srcset="https://tracker.test 2x" src="https://tracker.test">`,
    [],
  );
  expect(html).toContain("<p>Visible text</p>");
  expect(html).toContain(
    "display:block;width:96px !important;height:auto;border:0;height:1px !important",
  );
  expect(html).not.toMatch(
    /tracker|url\(|expression|var\(|calc\(|position|srcset|font-face|evil/iu,
  );
});

it("uses transparent placeholders without losing image descriptions or declared dimensions", () => {
  const html = sanitizeMailHtml(
    '<img src="cid:missing" alt="Company logo" width="200" height="40"><img src="https://blocked.test/photo" style="width:600px;height:auto"><img style="width:320px;height:80px">',
    [],
  );
  expect(html.split(mailImagePlaceholder)).toHaveLength(4);
  expect(html).toContain('alt="Company logo" width="200" height="40"');
  expect(html).toContain("height:40px !important");
  expect(html).toContain("height:auto;height:1px !important");
  expect(html).toContain("height:80px;height:80px !important");
  expect(html).not.toMatch(/blocked.test|cid:|Image unavailable|onerror/iu);
});
