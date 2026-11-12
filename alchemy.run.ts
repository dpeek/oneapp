import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Config, Effect } from "effect";
import { provisionOwner } from "./apps/web/src/server/provision-owner.ts";

const Database = Cloudflare.D1.Database("Database", {
  migrations: "./apps/web/drizzle",
});

export const Web = Cloudflare.Worker("Web", {
  main: "./apps/web/src/server/worker.ts",
  assets: { directory: "./apps/web/dist", runWorkerFirst: ["/api", "/api/*"] },
  compatibility: { date: "2026-11-01", flags: ["nodejs_compat"] },
  workersDev: { enabled: true, previewsEnabled: false },
  env: {
    DB: Database,
    APP_ORIGIN: Cloudflare.Worker.URL,
    AUTH_SECRET: Config.Redacted("AUTH_SECRET"),
    AUTH_LIMIT: Cloudflare.RateLimit("AuthLimit", {
      namespaceId: 1001,
      simple: { limit: 10, period: 60 },
    }),
  },
});

export type WorkerEnv = Cloudflare.InferEnv<typeof Web>;

export default Alchemy.Stack(
  "OneApp",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const database = yield* Database;
    const email = (yield* Config.String("OWNER_EMAIL")).trim().toLowerCase();
    yield* provisionOwner(database)({ databaseId: database.databaseId, email });
    const worker = yield* Web;
    return { url: worker.url };
  }),
);
