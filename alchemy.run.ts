import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import { Config, Effect, Layer, Option } from "effect";
import {
  forgotPasswordPage,
  resetPasswordPage,
} from "./apps/web/src/password-recovery-contract.ts";
import type { InboxUpdates } from "./apps/web/src/server/cloudflare-worker.ts";
import { provisionOwner } from "./apps/web/src/server/provision-owner.ts";

const Database = Cloudflare.D1.Database("Database", {
  migrations: "./apps/web/drizzle",
});

const VaultFiles = Cloudflare.R2.Bucket("VaultFiles", { publicAccess: false });

const InboxMessages = Cloudflare.R2.Bucket("InboxMessages", {
  publicAccess: false,
});

const SentMessages = Cloudflare.R2.Bucket("SentMessages", {
  publicAccess: false,
});

const ProfilePhotos = Cloudflare.R2.Bucket("ProfilePhotos", {
  publicAccess: false,
});

const inboxRouting = Effect.gen(function* () {
  const zoneId = yield* Config.option(Config.String("INBOX_EMAIL_ZONE_ID"));
  if (Option.isNone(zoneId)) return undefined;
  const hostname = yield* Config.String("APP_DOMAIN");
  return { zoneId: zoneId.value, name: hostname.toLowerCase() };
});

const inboxAddress = (hostname: string) => `mail@${hostname}`;

export const Web = Cloudflare.Worker(
  "Web",
  Effect.gen(function* () {
    const domain = yield* Config.option(Config.String("APP_DOMAIN"));
    const externalAuthSecrets = yield* Config.Boolean(
      "ONEAPP_EXTERNAL_AUTH_SECRETS",
    ).pipe(Config.withDefault(false));
    const emailZone = yield* Config.option(
      Config.String("ACCOUNT_EMAIL_ZONE_ID"),
    );
    const inbox = yield* inboxRouting;
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
      main: "./apps/web/src/server/cloudflare-worker.ts",
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
        INBOX_MESSAGES: InboxMessages,
        SENT_MESSAGES: SentMessages,
        PROFILE_PHOTOS: ProfilePhotos,
        INBOX_UPDATES: Cloudflare.DurableObject<InboxUpdates>("InboxUpdates"),
        ...(inbox ? { INBOX_EMAIL_ADDRESS: inboxAddress(inbox.name) } : {}),
        APP_ORIGIN: Cloudflare.Worker.URL,
        BITWARDEN_ICON_LIMIT: Cloudflare.RateLimit("BitwardenIconLimit", {
          namespaceId: 1004,
          simple: { limit: 300, period: 60 },
        }),
        ...(externalAuthSecrets
          ? {}
          : {
              AUTH_SECRET: Config.Redacted("AUTH_SECRET"),
              MCP_OAUTH_SECRET: Config.Redacted("MCP_OAUTH_SECRET"),
            }),
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
        ...(sending && inbox
          ? {
              INBOX_EMAIL_FROM: sending.enabled.pipe(
                Output.map((enabled) =>
                  enabled ? inboxAddress(inbox.name) : "",
                ),
              ),
              INBOX_SEND: Cloudflare.Email.SendEmail("InboxSend", {
                allowedSenderAddresses: [inboxAddress(inbox.name)],
              }),
              INBOX_SEND_LIMIT: Cloudflare.RateLimit("InboxSendLimit", {
                namespaceId: 1005,
                simple: { limit: 10, period: 60 },
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

export type WorkerEnv = Omit<
  Cloudflare.InferEnv<typeof Web>,
  "AUTH_SECRET" | "MCP_OAUTH_SECRET"
> & {
  AUTH_SECRET: string;
  MCP_OAUTH_SECRET: string;
};

export default Alchemy.Stack(
  "OneApp",
  {
    providers: Cloudflare.providers(),
    state: Layer.unwrap(
      Effect.map(Alchemy.AlchemyContext, ({ dev }) =>
        dev ? Alchemy.localState() : Cloudflare.state(),
      ),
    ),
  },
  Effect.gen(function* () {
    const inbox = yield* inboxRouting;
    const database = yield* Database;
    yield* provisionOwner(database)({ databaseId: database.databaseId });
    const worker = yield* Web;
    if (inbox) {
      const subdomain = yield* Cloudflare.Email.RoutingSubdomain(
        "InboxEmailDomain",
        inbox,
      );
      yield* Cloudflare.Email.Rule("InboxEmailRule", {
        zone: subdomain.zoneId,
        matchers: [
          {
            type: "literal",
            field: "to",
            value: subdomain.name.pipe(Output.map(inboxAddress)),
          },
        ],
        actions: [{ type: "worker", value: [worker.workerName] }],
      });
    }
    return { url: worker.url };
  }),
);
