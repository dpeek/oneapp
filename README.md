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
| `packages/ui`    | Shared Foldkit starter UI mounted by the web app and extension.                                                                                                                    |

The starter targets display the OneApp name. The inbox, authentication, and Cloudflare deployment come next.
