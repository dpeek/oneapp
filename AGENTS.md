# OneApp

- Bun workspace. Use Bun 1.4.4+ and `bun install` at the root. CLI, web, and extension live in `apps/`. Shared runtime-neutral code lives in `packages/core`; shared Foldkit UI lives in `packages/ui`.
- Verify with `bun check` and `bun run test` (Vitest on Bun with `@effect/vitest`). `bun run verify` also formats files. Use `bun run build` to check app builds.

## Library references

Use `bun.lock` for resolved versions. Verify APIs against installed source before relying on upstream examples.

- **Crease UI and StyleX**. Follow [Components and style system](packages/ui/STYLE_SYSTEM.md) for shared controls, typed tokens, and theme guidance.
- **Effect 4**. Start with `node_modules/effect/AGENTS.md`. Search `node_modules/effect/ai-docs` for examples and `node_modules/effect/src` for APIs.
- **Alchemy 2 beta**. `alchemy.run.ts` defines the Cloudflare Worker, D1 bindings, and owner provisioning. Read `node_modules/alchemy/src` and `node_modules/@alchemy.run/cloudflare/src`. Browse <https://alchemy.run/llms.txt> for upstream examples.
- **Yielded Auth beta**. Start with `apps/web/src/auth-contract.ts` and `apps/web/src/server/{auth,database,worker}.ts`. Installed source lives under `apps/web/node_modules/@yielded/{auth,auth-persistence-drizzle}/src`. See <https://yielded.dev/auth/guide/examples/> for upstream examples.

## Schema and deployment

- `apps/web/src/server/schema.ts` is the Drizzle schema entry point. Use `bun run db:generate` after schema changes and review the generated SQL.
- `bun run deploy` builds the web app and deploys to Cloudflare through `scripts/deploy.ts`. The web workspace's `dev` script serves the frontend only.
