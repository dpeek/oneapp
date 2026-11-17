import { appName } from "@oneapp/core";
import { OAuthServer } from "@yielded/auth";
import { Effect, Layer } from "effect";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const renderMcpConsent = (consent: OAuthServer.Consent) => {
  const client = escapeHtml(consent.clientName);
  const callback = new URL(consent.redirectUri);
  const clientHost = consent.registered
    ? ""
    : `<div><dt>Client</dt><dd>${escapeHtml(new URL(consent.clientId).hostname)}</dd></div>`;
  const permissions = consent.scopes
    .map((scope) =>
      scope === "links:read-write"
        ? "<li>Read and save your links</li>"
        : scope === "links:delete"
          ? "<li>Delete your saved links</li>"
          : `<li>${escapeHtml(scope)}</li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Allow ${client}? · ${appName}</title>
    <link rel="stylesheet" href="/mcp-consent.css">
  </head>
  <body>
    <main aria-labelledby="consent-title">
      <header>
        <p class="app-name">${appName}</p>
        <h1 id="consent-title">Allow ${client}?</h1>
      </header>
      <section aria-labelledby="permissions-title">
        <h2 id="permissions-title">Requested access</h2>
        <ul class="permissions">${permissions}</ul>
      </section>
      <dl>
        ${clientHost}
        <div><dt>Account</dt><dd>${escapeHtml(consent.subjectId)}</dd></div>
        <div><dt>Resource</dt><dd>${escapeHtml(consent.resource)}</dd></div>
        <div><dt>Returns to</dt><dd>${escapeHtml(callback.host)}</dd></div>
      </dl>
      ${callback.protocol === "http:" ? '<p class="notice">A local application will receive this authorization. Only allow access if you started this connection.</p>' : ""}
      <form method="post" action="${escapeHtml(consent.action)}">
        <input type="hidden" name="csrf" value="${escapeHtml(consent.csrf)}">
        <button class="secondary" name="decision" value="deny">Deny</button>
        <button class="primary" name="decision" value="approve">Allow</button>
      </form>
      <a class="account-link" href="${escapeHtml(consent.loginPath)}">Use another account</a>
    </main>
  </body>
</html>`;
};

export const McpConsentRenderer = Layer.succeed(OAuthServer.ConsentRenderer, {
  render: (consent) => Effect.succeed(renderMcpConsent(consent)),
});
