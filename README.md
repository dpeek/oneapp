# OneApp

A Bun workspace for the OneApp CLI, web app, and Chromium extension. The web app and extension popup use Foldkit and Effect.

## Getting started

Use Bun 1.4.4 or newer.

```sh
bun install
bun run verify
bun run build
```

Run `bun fmt` to format and `bun check` to type-check. `bun run test` runs Vitest on Bun with `@effect/vitest`, and `bun run test:watch` reruns tests as you edit. `bun run verify` formats files, then checks types and runs tests.

## Workspaces

| Workspace        | Run or build                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cli`       | `bun run --filter @oneapp/cli dev` runs from source. The build produces `apps/cli/dist/one` for the current platform.                                                              |
| `apps/web`       | `bun run --filter @oneapp/web dev` starts the local web app. The static build goes to `apps/web/dist`.                                                                             |
| `apps/extension` | `bun run --filter @oneapp/extension build` builds the popup and manifest. In `chrome://extensions`, enable Developer mode and load `apps/extension/dist` as an unpacked extension. |
| `packages/core`  | Shared, runtime-neutral TypeScript imported by all three apps.                                                                                                                     |
| `packages/ui`    | Foldkit starter UI mounted by the extension.                                                                                                                                       |

## Cloudflare preview

The Alchemy stack deploys the Foldkit web app and Effect API to one Worker. It creates a D1 database per stage, applies the committed Drizzle migrations, and provisions the owner through Yielded Auth.

Create a private, Git-ignored `.env.preview` from `.env.example` and set its permissions with `chmod 600 .env.preview`. Use the Cloudflare account ID, the name of your authenticated `cf` profile, and the owner's email address. Generate `OWNER_PASSWORD`, `AUTH_SECRET`, and `MCP_OAUTH_SECRET` separately with `bun -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'`. Keep the values stable for that stage. The password is used only during provisioning and the database stores its verifier. The session and OAuth signing keys are Worker secrets.

```sh
bun --env-file=.env.preview run deploy --stage preview
```

The deploy script uses the named `cf` profile locally. For CI, supply `CLOUDFLARE_API_TOKEN` and omit `CLOUDFLARE_AUTH_PROFILE`. A fresh stage gets its own Worker and database. `OWNER_EMAIL` and `OWNER_PASSWORD` are required only for the first provisioning of a database. Subsequent deploys use the existing owner in D1, including any email or password changes made in Settings. Use separate credentials for separate stages. Keep `.alchemy/state` private and available for subsequent deploys from the same checkout. It contains deployment secrets.

The main deployment uses `APP_DOMAIN=app.dpeek.com`. Alchemy attaches the hostname to the Worker, and Cloudflare manages DNS and TLS. Stages with a custom domain serve traffic on that domain. Stages without one use their `workers.dev` URL.

Set `ACCOUNT_EMAIL_ZONE_ID` to the Cloudflare DNS zone ID that owns `APP_DOMAIN` to enable account email. Alchemy onboards that hostname for Email Sending and the Worker sends from `accounts@APP_DOMAIN`. Leave this setting unset on preview deployments that should not send mail.

Cloudflare stores invocation logs and traces at 100% sampling and groups recurring errors in Workers Issues. Query strings are redacted from request URLs in telemetry.

Open the URL printed at the end of the deploy and sign in with the configured email and password. Under **Links** (`/links`), enter an HTTP or HTTPS URL and press Enter. Use **Delete** next to a saved link to remove it. **Settings** (`/settings`) shows your account and connected CLI, extension, and MCP access.

In **Settings → Account**, request a code to verify the current email or use your current password to set a new one. Password changes sign out all browser sessions and send a notice to the verified address when email sending is configured. New passwords must have at least 15 characters. For breach screening, the server sends the first five hexadecimal characters of the new password's SHA-1 hash to [Pwned Passwords](https://haveibeenpwned.com/API/v3#PwnedPasswords) and matches the returned hashes locally.

Use **Change email** in the same panel to enter the new address and your current password. The code must be confirmed within five minutes in the session that requested it. OneApp then switches the sign-in address, signs out browser sessions, and sends a notice to the previous address.

**Forgot password?** on the sign-in screen sends a single-use link to the verified sign-in address. It expires in five minutes and can be opened in another browser or on another device. Submitting a new password signs out all browser sessions. Sign in again with the new password.

`GET /api/health` is public. The web app uses a session for `GET /api/me` and for reading and changing links.

After a schema change, generate a migration with `bun run db:generate --name <change>` and commit the resulting files in `apps/web/drizzle`. Alchemy applies them on the next deployment.

## CLI

After installing workspace dependencies, run `bun link` from the CLI package directory to put `one` on your PATH. The link runs the TypeScript source directly with Bun. For a standalone binary, run `bun run --filter @oneapp/cli build`.

```sh
cd apps/cli
bun link
one auth login
one links add https://example.com/
one links list
one links list --ids
one links delete <id>
one auth logout
```

`one auth login` defaults to `https://app.dpeek.com`. Pass `--server <url>` for a different deployment.

The CLI opens a browser approval page and waits for your decision. Check that the code on the page matches your terminal, then choose **Connect CLI**. The request expires after five minutes. Use `--no-browser` to print the approval link for use on another device and `--name <label>` to name this device. To paste a token you created under **CLI access**, use `one auth login --manual-token`.

New CLI tokens authorize reading, saving, and deleting links until revoked. Run `one auth login` again to grant delete access to a CLI that was already signed in. The CLI stores the token in your OS credential store via `Bun.secrets`, keyed by server origin. Logout revokes the active token, and you can revoke any device’s token from the web app.

## Chrome extension

Run `bun run --filter @oneapp/extension build`. In Chrome, open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**. Select the `apps/extension/dist` directory.

Open OneApp from the Chrome toolbar and select **Connect to OneApp**. Approve the connection in the OneApp tab, signing in first if needed. On the page you want to keep, open the extension and select **Save this tab**. Saved links appear in the web app and in `one links list`.

New extension credentials only allow saving links and stay active until revoked. Use **Disconnect** in Chrome or **Manage extension access** in the web app to revoke one. Credentials issued under the previous 30-day policy keep their original expiry.

## MCP

OneApp serves Streamable HTTP at `https://app.dpeek.com/mcp`. The `list_links` tool returns links newest first with a `nextOffset` for paging. The `save_link` tool adds an HTTP or HTTPS URL, and `delete_link` removes a saved link by ID.

Register the server with Codex:

```sh
codex mcp add oneapp --url https://app.dpeek.com/mcp
```

Codex supplies its client ID automatically through its OAuth client metadata. Approve access in your browser. If the approval page doesn't open, run `codex mcp login oneapp`. Start a new Codex session to use the tools. For a setup that used `ONEAPP_MCP_TOKEN`, remove that MCP registration and add it again with the command above.

Access tokens refresh automatically within the 30-day grant. Open **Settings → MCP access** in the web app to revoke a grant.
For an existing Codex connection, run `codex mcp login oneapp --scopes links:read-write,links:delete` to approve deletion, then start a new Codex session.
