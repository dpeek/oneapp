import * as Cloudflare from "@alchemy.run/cloudflare";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { taskRunnerMcpPath } from "./packages/core/src/cli-auth.ts";
import { workspacePath } from "./packages/core/src/index.ts";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import { Config, Effect, Layer, Option, Redacted, Stream } from "effect";
import {
  forgotPasswordPage,
  resetPasswordPage,
} from "./apps/web/src/password-recovery-contract.ts";
import type { InboxUpdates } from "./apps/web/src/server/cloudflare-worker.ts";
import {
  primaryMailAddress,
  primaryMailDomain,
  orumaiMailDomain,
  winterpeekMailDomain,
  seedMailRoutes,
  initialMailAliases,
} from "./apps/web/src/server/mail-routing.ts";
import { provisionOwner } from "./apps/web/src/server/provision-owner.ts";

const Database = Cloudflare.D1.Database("Database", {
  migrations: "./apps/web/drizzle",
});

const FileUploads = Cloudflare.R2.Bucket("FileUploads", {
  publicAccess: false,
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

const provisionMailRoutes = Alchemy.Action(
  "ProvisionMailRoutes",
  Effect.gen(function* () {
    const database = yield* Cloudflare.D1.QueryDatabase(Database);
    return Effect.fn(function* ({
      aliases,
    }: {
      databaseId: string;
      ownerReady: boolean;
      aliases: string;
    }) {
      const db = yield* database.raw;
      yield* Effect.tryPromise(() => seedMailRoutes(db, aliases));
      return { ready: true };
    });
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal)),
);

const removeWinterpeekNullMx = Alchemy.Action(
  "RemoveWinterpeekNullMx",
  Effect.fn(function* (_input: { routesReady: boolean; workerName: string }) {
    const { accountId } = yield* Cloudflare.CloudflareEnvironment.current;
    const zoneId = yield* Cloudflare.Zone.resolveZoneId({
      accountId,
      zone: winterpeekMailDomain,
      hostname: winterpeekMailDomain,
    });
    yield* dns.listRecords
      .items({
        zoneId,
        name: { exact: winterpeekMailDomain },
        type: "MX",
      })
      .pipe(
        Stream.runForEach((record) =>
          record.type === "MX" &&
          record.priority === 0 &&
          record.content === "."
            ? dns
                .deleteRecord({ zoneId, dnsRecordId: record.id })
                .pipe(Effect.asVoid)
            : Effect.void,
        ),
      );
    return { zoneId };
  }),
);

export const Web = Cloudflare.Worker(
  "Web",
  Effect.gen(function* () {
    const { dev } = yield* Alchemy.AlchemyContext;
    const production = (yield* Alchemy.Stage) === "production" && !dev;
    const snapshot =
      dev &&
      (yield* Config.Boolean("ONEAPP_DEV_SNAPSHOT").pipe(
        Config.withDefault(false),
      ));
    const domain = yield* Config.option(Config.String("APP_DOMAIN"));
    const externalAuthSecrets = yield* Config.Boolean(
      "ONEAPP_EXTERNAL_AUTH_SECRETS",
    ).pipe(Config.withDefault(false));
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
    const inboxSending =
      production && Option.isSome(emailZone)
        ? yield* Cloudflare.Email.SendingSubdomain("InboxSendingDomain", {
            zoneId: emailZone.value,
            name: primaryMailDomain,
            previewEnabled: false,
          })
        : undefined;
    const from = `accounts@${Option.getOrUndefined(domain)}`;
    const assetRouting = {
      notFoundHandling: "none" as const,
      runWorkerFirst: [
        workspacePath,
        `${workspacePath}/*`,
        "/api",
        "/api/*",
        "/identity/*",
        "/icons/*",
        "/notifications/*",
        "/sso-connector.html",
        "/mcp",
        taskRunnerMcpPath,
        "/oauth/mcp/*",
        "/.well-known/*",
        "/connect/mcp",
        forgotPasswordPage,
        resetPasswordPage,
      ],
    };
    return {
      ...(dev
        ? {
            vite: {
              rootDir: "./apps/web",
              main: "./src/server/cloudflare-worker.ts",
            },
          }
        : { main: "./apps/web/src/server/cloudflare-worker.ts" }),
      dev: {
        strictPort: true,
        port: yield* Config.Number("ONEAPP_DEV_PORT").pipe(
          Config.withDefault(1337),
        ),
      },
      assets: dev
        ? assetRouting
        : { ...assetRouting, directory: "./apps/web/dist" },
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
      crons: snapshot ? [] : ["* * * * *"],
      env: {
        DB: Database,
        PUSH_PUBLIC_KEY: Config.String("PUSH_PUBLIC_KEY").pipe(
          Config.withDefault(""),
        ),
        PUSH_PRIVATE_KEY: Config.Redacted("PUSH_PRIVATE_KEY").pipe(
          Config.withDefault(Redacted.make("")),
        ),
        PUSH_SUBJECT: Config.String("PUSH_SUBJECT").pipe(
          Config.withDefault(""),
        ),
        MAILBOX_ALIASES: Config.String("MAILBOX_ALIASES").pipe(
          Config.withDefault(""),
        ),
        FILE_UPLOADS: FileUploads,
        VAULT_FILES: VaultFiles,
        INBOX_MESSAGES: InboxMessages,
        SENT_MESSAGES: SentMessages,
        PROFILE_PHOTOS: ProfilePhotos,
        INBOX_UPDATES: Cloudflare.DurableObject<InboxUpdates>("InboxUpdates"),
        ...(production || dev
          ? { INBOX_EMAIL_ADDRESS: primaryMailAddress }
          : {}),
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
        ...(inboxSending
          ? {
              INBOX_EMAIL_FROM: inboxSending.enabled.pipe(
                Output.map((enabled): string =>
                  enabled ? primaryMailAddress : "",
                ),
              ),
              INBOX_SEND: Cloudflare.Email.SendEmail("InboxSend", {
                allowedSenderAddresses: [primaryMailAddress],
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
  // Keep existing stages associated with their provisioned resources.
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
    const { dev } = yield* Alchemy.AlchemyContext;
    const production = (yield* Alchemy.Stage) === "production" && !dev;
    const database = yield* Database;
    const owner = yield* provisionOwner(database)({
      databaseId: database.databaseId,
    });
    const worker = yield* Web;
    if (production) {
      const routes = yield* provisionMailRoutes({
        databaseId: database.databaseId,
        ownerReady: owner.ready,
        aliases: initialMailAliases,
      });
      const winterpeek = yield* removeWinterpeekNullMx({
        routesReady: routes.ready,
        workerName: worker.workerName,
      });
      for (const [id, domain] of [
        ["Dpeek", routes.ready.pipe(Output.map(() => primaryMailDomain))],
        ["Orumai", routes.ready.pipe(Output.map(() => orumaiMailDomain))],
        ["Winterpeek", winterpeek.zoneId],
      ] as const) {
        // Wait for D1 before enabling ingress. Routing also provisions the
        // apex MX records on Cloudflare DNS.
        const routing = yield* Cloudflare.Email.Routing(`${id}EmailRouting`, {
          zone: domain,
        }).pipe(Alchemy.RemovalPolicy.retain());
        yield* Cloudflare.Email.CatchAll(`${id}EmailCatchAll`, {
          zone: routing.zoneId,
          actions: [{ type: "worker", value: [worker.workerName] }],
        });
      }
    }
    return { url: worker.url };
  }),
);
