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

Create a private, Git-ignored `.env.preview` from `.env.example` and set its permissions with `chmod 600 .env.preview`. Use the Cloudflare account ID, the name of your authenticated `cf` profile, and the owner's email address. Generate `OWNER_PASSWORD` and `AUTH_SECRET` separately with `bun -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'`. Keep both values stable for that stage. The password is used only during provisioning and the database stores its verifier. The session secret is a Worker secret.

```sh
bun --env-file=.env.preview run deploy --stage preview
```

The deploy script uses the named `cf` profile locally. For CI, supply `CLOUDFLARE_API_TOKEN` and omit `CLOUDFLARE_AUTH_PROFILE`. A fresh stage gets its own Worker and database. Provisioning leaves an existing owner's password in place, even on a forced redeploy. Use separate credentials for separate stages. Keep `.alchemy/state` private and available for subsequent deploys from the same checkout. It contains deployment secrets.

The main deployment uses `APP_DOMAIN=app.dpeek.com`. Alchemy attaches the hostname to the Worker, and Cloudflare manages DNS and TLS. Stages with a custom domain serve traffic on that domain. Stages without one use their `workers.dev` URL.

Cloudflare stores invocation logs and traces at 100% sampling and groups recurring errors in Workers Issues. Query strings are redacted from request URLs in telemetry.

Open the URL printed at the end of the deploy and sign in with the configured email and password. Save an HTTP or HTTPS URL to see it in your links, newest first. `GET /api/health` is public. `GET /api/me`, `GET /api/links`, and `POST /api/links` require a session.

After a schema change, generate a migration with `bun run db:generate --name <change>` and commit the resulting files in `apps/web/drizzle`. Alchemy applies them on the next deployment.

## CLI

After installing workspace dependencies, run `bun link` from the CLI package directory to put `one` on your PATH. The link runs the TypeScript source directly with Bun. For a standalone binary, run `bun run --filter @oneapp/cli build`.

```sh
cd apps/cli
bun link
one auth login
one links add https://example.com/
one links list
one auth logout
```

`one auth login` defaults to `https://app.dpeek.com`. Pass `--server <url>` for a different deployment.

The CLI opens a browser approval page and waits for your decision. Check that the code on the page matches your terminal, then choose **Connect CLI**. The request expires after five minutes. Use `--no-browser` to print the approval link for use on another device and `--name <label>` to name this device. To paste a token you created under **CLI access**, use `one auth login --manual-token`.

New CLI tokens authorize reading and saving links until revoked. The CLI stores the token in your OS credential store via `Bun.secrets`, keyed by server origin. Logout revokes the active token, and you can revoke any device’s token from the web app.

## Chrome extension

Run `bun run --filter @oneapp/extension build`. In Chrome, open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**. Select the `apps/extension/dist` directory.

Open OneApp from the Chrome toolbar and select **Connect to OneApp**. Approve the connection in the OneApp tab, signing in first if needed. On the page you want to keep, open the extension and select **Save this tab**. Saved links appear in the web app and in `one links list`.

New extension credentials only allow saving links and stay active until revoked. Use **Disconnect** in Chrome or **Manage extension access** in the web app to revoke one. Credentials issued under the previous 30-day policy keep their original expiry.
