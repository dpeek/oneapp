import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import { Config, Effect, Option } from "effect";
import {
  forgotPasswordPage,
  resetPasswordPage,
} from "./apps/web/src/password-recovery-contract.ts";
import { provisionOwner } from "./apps/web/src/server/provision-owner.ts";

const Database = Cloudflare.D1.Database("Database", {
  migrations: "./apps/web/drizzle",
});

const VaultFiles = Cloudflare.R2.Bucket("VaultFiles", { publicAccess: false });

export const Web = Cloudflare.Worker(
  "Web",
  Effect.gen(function* () {
    const domain = yield* Config.option(Config.String("APP_DOMAIN"));
    const emailZone = yield* Config.option(
      Config.String("ACCOUNT_EMAIL_ZONE_ID"),
    );
    const sending = yield* Effect.gen(function* () {
      if (Option.isNone(emailZone)) return undefined;
      const hostname = yield* Config.String("APP_DOMAIN");
      return yield* Cloudflare.Email.SendingSubdomain("AccountEmailDomain", {
        zoneId: emailZone.value,
        name: hostname,
        previewEnabled: false,
      });
    });
    const from = `accounts@${Option.getOrUndefined(domain)}`;
    return {
      main: "./apps/web/src/server/worker.ts",
      assets: {
        directory: "./apps/web/dist",
        notFoundHandling: "single-page-application" as const,
        runWorkerFirst: [
          "/api",
          "/api/*",
          "/identity/*",
          "/icons/*",
          "/notifications/*",
          "/sso-connector.html",
          "/mcp",
          "/oauth/mcp/*",
          "/.well-known/*",
          "/connect/mcp",
          forgotPasswordPage,
          resetPasswordPage,
        ],
      },
      compatibility: {
        date: "2026-11-01",
        flags: ["nodejs_compat", "global_fetch_strictly_public"],
      },
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
      crons: ["*/15 * * * *"],
      env: {
        DB: Database,
        VAULT_FILES: VaultFiles,
        APP_ORIGIN: Cloudflare.Worker.URL,
        BITWARDEN_ICON_LIMIT: Cloudflare.RateLimit("BitwardenIconLimit", {
          namespaceId: 1004,
          simple: { limit: 300, period: 60 },
        }),
        AUTH_SECRET: Config.Redacted("AUTH_SECRET"),
        MCP_OAUTH_SECRET: Config.Redacted("MCP_OAUTH_SECRET"),
        AUTH_LIMIT: Cloudflare.RateLimit("AuthLimit", {
          namespaceId: 1001,
          simple: { limit: 10, period: 60 },
        }),
        ACCOUNT_EMAIL_LIMIT: Cloudflare.RateLimit("AccountEmailLimit", {
          namespaceId: 1003,
          simple: { limit: 3, period: 60 },
        }),
        ...(sending
          ? {
              EMAIL_FROM: sending.enabled.pipe(
                Output.map((enabled) => (enabled ? from : "")),
              ),
              ACCOUNT_EMAIL: Cloudflare.Email.SendEmail("AccountEmail", {
                allowedSenderAddresses: [from],
              }),
            }
          : {}),
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
    yield* provisionOwner(database)({ databaseId: database.databaseId });
    const worker = yield* Web;
    return { url: worker.url };
  }),
);
