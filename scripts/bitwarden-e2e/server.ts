import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigProvider, Effect } from "effect";
import type { WorkerEnv } from "../../alchemy.run.ts";
import { ensureOwner } from "../../apps/web/src/server/provision-owner.ts";
import { fixtureEmail, type makeFixture } from "./fixture.ts";

const directory = process.env.ONEAPP_BITWARDEN_E2E_DIRECTORY;
const port = Number(process.env.ONEAPP_BITWARDEN_E2E_PORT);
const ownerPassword = process.env.ONEAPP_BITWARDEN_E2E_OWNER_PASSWORD;
const restartKey = process.env.ONEAPP_BITWARDEN_E2E_RESTART_KEY;
if (!directory || !port || !ownerPassword || !restartKey)
  throw new Error("Run the Bitwarden browser test runner.");

const file = Bun.file(join(directory, "vault.json"));
const fixture: ReturnType<typeof makeFixture> | null = (await file.exists())
  ? await file.json()
  : null;
const appDirectory = fileURLToPath(new URL("../../apps/web/", import.meta.url));
const origin = `https://127.0.0.1:${port}`;
const authSecret = Buffer.from(
  crypto.getRandomValues(new Uint8Array(32)),
).toString("base64url");
const mcpSecret = Buffer.from(
  crypto.getRandomValues(new Uint8Array(32)),
).toString("base64url");

const require = createRequire(join(directory, "package.json"));
const { Miniflare } = require("miniflare") as {
  Miniflare: new (options: object) => {
    getR2Bucket: (name: string) => Promise<WorkerEnv["VAULT_FILES"]>;
    getD1Database: (name: string) => Promise<WorkerEnv["DB"]>;
    dispatchFetch: (input: string, init: RequestInit) => Promise<Response>;
    dispose: () => Promise<void>;
  };
};
const limit = (id: number, max: number) => ({
  namespace_id: String(id),
  simple: { limit: max, period: 60 },
});
let storage = directory;
const makeRuntime = () =>
  new Miniflare({
    host: "127.0.0.1",
    port: 0,
    https: true,
    httpsCertPath: join(directory, "cert.pem"),
    httpsKeyPath: join(directory, "key.pem"),
    cf: false,
    modules: true,
    modulesRoot: directory,
    scriptPath: join(directory, "worker.mjs"),
    compatibilityDate: "2026-11-01",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "oneapp-bitwarden-e2e" },
    d1Persist: join(storage, "d1"),
    r2Buckets: { VAULT_FILES: "oneapp-bitwarden-files" },
    r2Persist: join(storage, "r2"),
    bindings: {
      APP_ORIGIN: origin,
      AUTH_SECRET: authSecret,
      MCP_OAUTH_SECRET: mcpSecret,
    },
    ratelimits: {
      // Two local profiles run a burst of explicit syncs from one test address.
      AUTH_LIMIT: limit(1001, 60),
      CLI_LOGIN_LIMIT: limit(1002, 30),
      ACCOUNT_EMAIL_LIMIT: limit(1003, 3),
    },
    assets: {
      directory: join(appDirectory, "dist"),
      binding: "ASSETS",
      assetConfig: { not_found_handling: "single-page-application" },
      routerConfig: {
        has_user_worker: true,
        static_routing: {
          user_worker: [
            "/api/*",
            "/identity/*",
            "/notifications/*",
            "/sso-connector.html",
          ],
        },
      },
    },
  });

let runtime = makeRuntime();
const db = await runtime.getD1Database("DB");
const migrationDirectory = join(appDirectory, "drizzle");
const migrations = Array.from(
  new Bun.Glob("*/migration.sql").scanSync(migrationDirectory),
).sort();
const applyMigrations = async (files: string[], target = db) => {
  for (const file of files) {
    const source = await Bun.file(join(migrationDirectory, file)).text();
    await target.batch(
      source
        .split("--> statement-breakpoint")
        .filter((sql) => sql.trim())
        .map((sql) => target.prepare(sql)),
    );
  }
};
const legacyLoginMigration = migrations.findIndex((file) =>
  file.endsWith("_bitwarden_vaults/migration.sql"),
);
if (legacyLoginMigration < 0)
  throw new Error("The original vault migration is missing.");
const beforeSeed = fixture ? legacyLoginMigration + 1 : migrations.length;
await applyMigrations(migrations.slice(0, beforeSeed));
const provision = (target: WorkerEnv["DB"]) =>
  Effect.runPromise(
    ensureOwner(target).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({
          OWNER_EMAIL: fixtureEmail,
          OWNER_PASSWORD: ownerPassword,
          AUTH_SECRET: authSecret,
        }),
      ),
    ),
  );
await provision(db);

if (fixture) {
  const { vault, login } = fixture;
  await db.batch([
    db
      .prepare(
        `
    INSERT INTO personal_vaults (id, owner_id, kdf_salt, kdf_iterations, wrapped_key, key_id,
       wrapped_private_key, public_key, created_at, revision_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
      )
      .bind(
        vault.id,
        vault.ownerId,
        vault.kdfSalt,
        vault.kdfIterations,
        vault.wrappedKey,
        vault.keyId,
        vault.wrappedPrivateKey,
        vault.publicKey,
        vault.createdAt,
        vault.revisionAt,
      ),
    db
      .prepare(
        `
    INSERT INTO personal_vault_logins (id, vault_id, name, wrapped_key, username, password, uri, created_at, revision_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
      )
      .bind(
        login.id,
        login.vaultId,
        login.name,
        login.wrappedKey,
        login.username,
        login.password,
        login.uri,
        login.createdAt,
        login.revisionAt,
      ),
  ]);
  await applyMigrations(migrations.slice(beforeSeed));
}

let restart: Promise<void> | undefined;
const restartWorker = async (expectedItems: number) => {
  await runtime.dispose();
  runtime = makeRuntime();
  const persistentDb = await runtime.getD1Database("DB");
  const savedVault = await persistentDb
    .prepare("SELECT id FROM personal_vaults WHERE owner_id = 'owner'")
    .first<{ id: string }>();
  if (!savedVault) throw new Error("The vault did not persist across restart.");
  const [device, items] = await Promise.all([
    persistentDb
      .prepare("SELECT id FROM bitwarden_device_sessions WHERE vault_id = ?")
      .bind(savedVault.id)
      .first(),
    persistentDb
      .prepare(
        "SELECT count(*) AS total FROM personal_vault_logins WHERE vault_id = ?",
      )
      .bind(savedVault.id)
      .first<{ total: number }>(),
  ]);
  if (!device || items?.total !== expectedItems)
    throw new Error(
      "The vault items or device session did not persist across restart.",
    );
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  tls: {
    cert: Bun.file(join(directory, "cert.pem")),
    key: Bun.file(join(directory, "key.pem")),
  },
  async fetch(request) {
    const url = new URL(request.url);
    if (
      ["login.oneapp.test", "login.oneapp-vault.test"].includes(url.hostname)
    ) {
      if (request.method !== "GET" || url.pathname !== "/fixture-login")
        return new Response(null, { status: 404 });
      return new Response(
        `<!doctype html><html lang="en"><title>Fixture sign in</title>
        <form><label>Username <input name="username" autocomplete="username"></label>
        <label>Password <input name="password" type="password" autocomplete="current-password"></label>
        <button type="button">Sign in</button></form></html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        },
      );
    }
    if (url.pathname === "/_test/attachment-objects") {
      if (
        request.method !== "GET" ||
        request.headers.get("x-test-restart") !== restartKey
      )
        return new Response(null, { status: 404 });
      const files = await runtime.getR2Bucket("VAULT_FILES");
      const result = await files.list();
      return Response.json({ count: result.objects.length });
    }
    if (url.pathname === "/_test/fresh-vault") {
      if (
        request.method !== "POST" ||
        request.headers.get("x-test-restart") !== restartKey ||
        storage !== directory
      )
        return new Response(null, { status: 404 });
      await runtime.dispose();
      storage = join(directory, "destination");
      runtime = makeRuntime();
      const target = await runtime.getD1Database("DB");
      await applyMigrations(migrations, target);
      await provision(target);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/_test/restart") {
      if (
        request.method !== "POST" ||
        request.headers.get("x-test-restart") !== restartKey
      )
        return new Response(null, { status: 404 });
      const expectedItems = Number(url.searchParams.get("items"));
      if (!Number.isInteger(expectedItems) || expectedItems < 1)
        return new Response(null, { status: 400 });
      await (restart ??= restartWorker(expectedItems).finally(() => {
        restart = undefined;
      }));
      return new Response(null, { status: 204 });
    }
    await restart;
    const body = request.body ? await request.arrayBuffer() : undefined;
    const response = await runtime.dispatchFetch(url.href, {
      method: request.method,
      headers: request.headers,
      body,
      redirect: "manual",
    });
    const grant =
      url.pathname === "/identity/connect/token" && body
        ? new URLSearchParams(new TextDecoder().decode(body)).get("grant_type")
        : undefined;
    console.log(
      JSON.stringify({
        method: request.method,
        path: url.pathname,
        grant:
          grant === "authorization_code" || grant === "refresh_token"
            ? grant
            : undefined,
        status: response.status,
      }),
    );
    return new Response(
      response.body === null ? null : await response.arrayBuffer(),
      {
        status: response.status,
        headers: response.headers,
      },
    );
  },
});

process.on("SIGTERM", async () => {
  await server.stop(true);
  await runtime.dispose();
  process.exit(0);
});
