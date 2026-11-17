import { expect, it } from "@effect/vitest";
import { Schema } from "@yielded/auth";
import { renderMcpConsent } from "./mcp-consent.ts";

it("escapes consent metadata and preserves the approval form", () => {
  const html = renderMcpConsent({
    clientName: '<img src=x onerror="alert(1)">',
    clientId: "https://chatgpt.com/oauth/codex/client.json",
    registered: false,
    subjectId: Schema.SubjectId.make("owner"),
    resource: "https://app.dpeek.com/mcp",
    scopes: ["links:read-write", "links:delete", "<custom>"],
    redirectUri: "http://127.0.0.1:55162/callback",
    action: "/oauth/mcp/authorize",
    loginPath: "/connect/mcp",
    csrf: 'token"&',
  });

  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  expect(html).toContain("Read and save your links");
  expect(html).toContain("Delete your saved links");
  expect(html).toContain("&lt;custom&gt;");
  expect(html).toContain('method="post" action="/oauth/mcp/authorize"');
  expect(html).toContain('name="csrf" value="token&quot;&amp;"');
  expect(html).toContain('name="decision" value="approve"');
  expect(html).toContain('name="decision" value="deny"');
  expect(html).toContain("127.0.0.1:55162");
});
