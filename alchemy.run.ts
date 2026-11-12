import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Config, Effect, Option } from "effect";
import { provisionOwner } from "./apps/web/src/server/provision-owner.ts";

const Database = Cloudflare.D1.Database("Database", {
  migrations: "./apps/web/drizzle",
});

export const Web = Cloudflare.Worker(
  "Web",
  Effect.gen(function* () {
    const domain = yield* Config.option(Config.String("APP_DOMAIN"));
    return {
      main: "./apps/web/src/server/worker.ts",
      assets: {
        directory: "./apps/web/dist",
        runWorkerFirst: ["/api", "/api/*"],
      },
      compatibility: { date: "2026-11-01", flags: ["nodejs_compat"] },
      domain: Option.getOrUndefined(domain),
      workersDev: { enabled: Option.isNone(domain), previewsEnabled: false },
      observability: {
        enabled: true,
        headSamplingRate: 1,
        redactQueryString: true,
        logs: {
          enabled: true,
          invocationLogs: true,
          headSamplingRate: 1,
          persist: true,
        },
        traces: { enabled: true, headSamplingRate: 1, persist: true },
        issues: { enabled: true },
      },
      env: {
        DB: Database,
        APP_ORIGIN: Cloudflare.Worker.URL,
        AUTH_SECRET: Config.Redacted("AUTH_SECRET"),
        AUTH_LIMIT: Cloudflare.RateLimit("AuthLimit", {
          namespaceId: 1001,
          simple: { limit: 10, period: 60 },
        }),
        CLI_LOGIN_LIMIT: Cloudflare.RateLimit("CliLoginLimit", {
          namespaceId: 1002,
          simple: { limit: 30, period: 60 },
        }),
      },
    };
  }),
);

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
