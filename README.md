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

The Alchemy stack deploys the Foldkit web app and Effect API to one Worker on `workers.dev`. It creates a D1 database per stage, applies the committed Drizzle migrations, and provisions the owner through Yielded Auth. The CLI and extension are still starter targets.

Create a private, Git-ignored `.env.preview` from `.env.example` and set its permissions with `chmod 600 .env.preview`. Use the Cloudflare account ID, the name of your authenticated `cf` profile, and the owner's email address. Generate `OWNER_PASSWORD` and `AUTH_SECRET` separately with `bun -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'`. Keep both values stable for that stage. The password is used only during provisioning and the database stores its verifier. The session secret is a Worker secret.

```sh
bun --env-file=.env.preview run deploy --stage preview
```

The deploy script uses the named `cf` profile locally. For CI, supply `CLOUDFLARE_API_TOKEN` and omit `CLOUDFLARE_AUTH_PROFILE`. A fresh stage gets its own Worker and database. Provisioning leaves an existing owner's password in place, even on a forced redeploy. Use separate credentials for separate stages. Keep `.alchemy/state` private and available for subsequent deploys from the same checkout. It contains deployment secrets.

Open the URL printed at the end of the deploy and sign in with the configured email and password. `GET /api/health` is public and `GET /api/me` requires a session.

After a schema change, generate a migration with `bun run db:generate --name <change>` and commit the resulting files in `apps/web/drizzle`. Alchemy applies them on the next deployment.
