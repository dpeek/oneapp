// Sanitized on the server, then isolated from the app as a second boundary.
export const mailHtmlSandbox = "allow-popups allow-popups-to-escape-sandbox";
export const mailHtmlDocument = (html: string) => `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { color-scheme: light; font: 15px/1.6 system-ui, sans-serif; color: #202124; background: white; }
body { margin: 16px; overflow-wrap: anywhere; }
img { max-width: 100%; height: auto; }
table { max-width: 100%; }
pre { white-space: pre-wrap; }
blockquote { margin-inline: 0; padding-inline-start: 12px; border-inline-start: 2px solid #dadce0; }
a { color: #1558d6; }
</style></head><body>${html}</body></html>`;
