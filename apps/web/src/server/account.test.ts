import { expect, it, vi } from "@effect/vitest";
import {
  cliLinkScopes,
  cliLoginPath,
  cliTokensPath,
} from "@oneapp/core/cli-auth";
import { extensionAccessPath, digestSecret } from "@oneapp/core/extension-auth";
import {
  linkPath,
  linksPath,
  linksReadScope,
  linksWriteScope,
} from "@oneapp/core/links";
import { EmailDelivery } from "@yielded/auth";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { ConfigProvider, Effect, Redacted, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import type { WorkerEnv } from "../../../../alchemy.run.ts";
import {
  emailChangePath,
  emailVerificationPath,
  passwordChangePath,
} from "../account-contract.ts";
import {
  codexClientId,
  McpGrantList,
  mcpGrantsPath,
} from "../mcp-access-contract.ts";
import {
  passwordResetPath,
  resetPasswordPage,
} from "../password-recovery-contract.ts";
import { vaultSetupPath } from "../vault-setup-contract.ts";
import { createVaultSetup } from "../vault-setup-crypto.ts";
import { ensureOwner } from "./provision-owner.ts";
import { mcpOAuth } from "./mcp-oauth.ts";
import worker from "./worker.ts";

const email = "owner@example.net";
const password = "p".repeat(43);

const setup = async (sqlite: Database) => {
  const migrationRoot = new URL("../../drizzle/", import.meta.url).pathname;
  for (const entry of Array.from(
    new Bun.Glob("*/migration.sql").scanSync(migrationRoot),
  ).sort()) {
    sqlite.exec(await Bun.file(migrationRoot + entry).text());
  }

  const bind = (sql: string, params: SQLQueryBindings[]) => {
    const execute = () => ({ results: sqlite.query(sql).all(...params) });
    return {
      execute,
      all: async () => execute(),
      first: async () => execute().results[0] ?? null,
      raw: async () => sqlite.query(sql).values(...params),
    };
  };
  let emailAvailable = true;
  const messages: { from: string; to: string; text: string }[] = [];
  const deliveries: Promise<unknown>[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...params: SQLQueryBindings[]) => bind(sql, params),
      }),
      batch: async (statements: ReturnType<typeof bind>[]) =>
        sqlite.transaction(() =>
          statements.map((statement) => statement.execute()),
        )(),
    },
    APP_ORIGIN: "https://oneapp.example",
    AUTH_SECRET: "x".repeat(43),
    MCP_OAUTH_SECRET: "y".repeat(43),
    AUTH_LIMIT: { limit: async () => ({ success: true }) },
    ACCOUNT_EMAIL_LIMIT: { limit: async () => ({ success: true }) },
    CLI_LOGIN_LIMIT: { limit: async () => ({ success: true }) },
    EMAIL_FROM: "accounts@oneapp.example",
    ASSETS: { fetch: async () => new Response("<html></html>") },
    ACCOUNT_EMAIL: {
      send: async (message: { from: string; to: string; text: string }) => {
        if (!emailAvailable) throw new Error("Email unavailable");
        messages.push(message);
      },
    },
  } as unknown as WorkerEnv;
  const provision = (config: Record<string, string>) =>
    Effect.runPromise(
      ensureOwner(env.DB).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(config),
        ),
      ),
    );
  await provision({
    OWNER_EMAIL: email,
    OWNER_PASSWORD: password,
    AUTH_SECRET: env.AUTH_SECRET,
  });

  const request = (path: string, init: RequestInit) =>
    worker.fetch(new Request(new URL(path, env.APP_ORIGIN), init), env, {
      waitUntil: (work) => deliveries.push(work),
    });
  const call = (
    path: string,
    body?: object,
    cookie?: string,
    origin = env.APP_ORIGIN,
  ) =>
    request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "x-effect-auth-csrf": "1",
        origin,
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const signIn = (candidate: string, address = email) =>
    call("/api/auth/signIn", {
      payload: { email: address, password: candidate },
    });
  const cookies = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((header) => header.split(";")[0])
      .join("; ");

  return {
    call,
    request,
    signIn,
    cookies,
    messages,
    from: env.EMAIL_FROM,
    provision,
    awaitDeliveries: () => Promise.all(deliveries.splice(0)),
    setEmailAvailable: (available: boolean) => {
      emailAvailable = available;
    },
  };
};

it("issues scoped CLI tokens and applies read and write scopes to the Links API", async () => {
  using sqlite = new Database(":memory:");
  const { call, request, signIn, cookies } = await setup(sqlite);
  const session = cookies(await signIn(password));
  const credential = (
    secret: string,
    path: string,
    method = "GET",
    body?: object,
  ) =>
    request(path, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  const secret = `one_${"a".repeat(43)}`;
  const start = await credential(secret, cliLoginPath, "POST", {
    label: "Laptop",
  });
  expect(start.status).toBe(201);
  const { id } = (await start.json()) as { id: string };
  const approval = `${cliLoginPath}/${id}`;
  expect((await call(approval, { approve: true }, session)).status).toBe(400);
  expect(
    (await call(approval, { approve: true, scopes: cliLinkScopes }, session))
      .status,
  ).toBe(204);
  expect((await credential(secret, `${approval}/poll`, "POST")).status).toBe(
    204,
  );

  expect(
    (
      await call(
        cliTokensPath,
        { label: "Mac mini", scopes: cliLinkScopes },
        session,
      )
    ).status,
  ).toBe(404);
  const tokens = await call(cliTokensPath, undefined, session);
  expect(tokens.status).toBe(200);
  expect(await tokens.json()).toMatchObject([{ id, label: "Laptop" }]);
  const save = await credential(secret, linksPath, "POST", {
    url: "https://example.com/",
  });
  expect(save.status).toBe(201);
  const link = (await save.json()) as { id: string };
  expect(await (await credential(secret, linksPath)).json()).toMatchObject([
    link,
  ]);

  sqlite.run("UPDATE cli_tokens SET scopes = ? WHERE id = ?", [
    JSON.stringify([linksReadScope]),
    id,
  ]);
  expect((await credential(secret, linksPath)).status).toBe(200);
  expect(
    (
      await credential(secret, linksPath, "POST", {
        url: "https://example.org/",
      })
    ).status,
  ).toBe(403);
  expect((await credential(secret, linkPath(link.id), "DELETE")).status).toBe(
    403,
  );

  sqlite.run("UPDATE cli_tokens SET scopes = ? WHERE id = ?", [
    JSON.stringify([linksWriteScope]),
    id,
  ]);
  expect((await credential(secret, linksPath)).status).toBe(403);
  expect((await credential(secret, linkPath(link.id), "DELETE")).status).toBe(
    204,
  );

  const revoked = await request(`${cliTokensPath}/${id}`, {
    method: "DELETE",
    headers: {
      cookie: session,
      origin: "https://oneapp.example",
      "x-effect-auth-csrf": "1",
    },
  });
  expect(revoked.status).toBe(204);
  expect((await credential(secret, linksPath)).status).toBe(401);
  expect((await credential(secret, `${approval}/poll`, "POST")).status).toBe(
    410,
  );

  const extensionSecret = `one_ext_${"b".repeat(43)}`;
  expect(
    (
      await call(
        extensionAccessPath,
        {
          id: crypto.randomUUID(),
          digest: await digestSecret(extensionSecret),
        },
        session,
      )
    ).status,
  ).toBe(204);
  const extensionSave = await credential(extensionSecret, linksPath, "POST", {
    url: "https://example.org/",
  });
  expect(extensionSave.status).toBe(201);
  const extensionLink = (await extensionSave.json()) as { id: string };
  expect((await credential(extensionSecret, linksPath)).status).toBe(401);
  expect(
    (await credential(extensionSecret, linkPath(extensionLink.id), "DELETE"))
      .status,
  ).toBe(401);
});

it("issues MCP link scopes and exposes only the tools a grant authorises", async () => {
  using sqlite = new Database(":memory:");
  const { call, request, signIn, cookies } = await setup(sqlite);
  const session = cookies(await signIn(password));
  const origin = "https://oneapp.example";
  const resource = `${origin}/mcp`;
  const redirectUri = "http://127.0.0.1:52127/callback";
  const form = (
    path: string,
    fields: Record<string, string>,
    cookie?: string,
  ) =>
    request(path, {
      method: "POST",
      headers: { origin, ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(fields),
    });

  const connect = async (scopes?: string[]) => {
    const verifier = Base64Url.encode(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const authorization = new URLSearchParams({
      response_type: "code",
      client_id: codexClientId,
      redirect_uri: redirectUri,
      resource,
      code_challenge_method: "S256",
      code_challenge: Base64Url.encode(new Uint8Array(digest)),
      ...(scopes === undefined ? {} : { scope: scopes.join(" ") }),
    });
    const start = await request(
      `${mcpOAuth.paths.authorize}?${authorization}`,
      { headers: { cookie: session } },
    );
    expect(start.status).toBe(303);
    const consentCookie = [session, cookies(start)].join("; ");
    const consent = await request(mcpOAuth.paths.authorize, {
      headers: { cookie: consentCookie },
    });
    expect(consent.status).toBe(200);
    const csrf = (await consent.text()).match(
      /name="csrf" value="([^"]+)"/,
    )?.[1];
    expect(csrf).toBeDefined();
    const approved = await form(
      mcpOAuth.paths.authorize,
      { decision: "approve", csrf: csrf! },
      consentCookie,
    );
    expect(approved.status, await approved.clone().text()).toBe(303);
    const code = new URL(
      approved.headers.get("location") ?? "",
    ).searchParams.get("code");
    expect(code).toBeTruthy();
    const issued = await form(mcpOAuth.paths.token, {
      grant_type: "authorization_code",
      client_id: codexClientId,
      redirect_uri: redirectUri,
      resource,
      code: code!,
      code_verifier: verifier,
    });
    expect(issued.status, await issued.clone().text()).toBe(200);
    const grant = (await issued.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(grant.scope).toBe(
      (scopes ?? [linksReadScope, linksWriteScope]).join(" "),
    );
    return grant;
  };

  const mcp = async (token: string, method: string, params = {}) => {
    const response = await request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const data = response.headers
      .get("content-type")
      ?.startsWith("text/event-stream")
      ? body.match(/^data: (.+)$/m)?.[1]
      : body;
    return JSON.parse(data ?? "") as {
      error?: { message: string };
      result?: { tools?: { name: string }[]; structuredContent?: unknown };
    };
  };
  const names = async (token: string) =>
    (await mcp(token, "tools/list")).result?.tools
      ?.map(({ name }) => name)
      .sort();
  const useTool = (token: string, name: string, args = {}) =>
    mcp(token, "tools/call", { name, arguments: args });

  const challenge = await request("/mcp", { method: "POST" });
  expect(challenge.status).toBe(401);
  expect(challenge.headers.get("www-authenticate")).toContain(
    `scope="${linksReadScope} ${linksWriteScope}"`,
  );
  const metadata = await request(
    "/.well-known/oauth-protected-resource/mcp",
    {},
  );
  expect(await metadata.json()).toMatchObject({
    scopes_supported: [linksReadScope, linksWriteScope],
  });

  const connectedAfter = Date.now();
  const full = await connect();
  const readGrant = await connect([linksReadScope]);
  const read = readGrant.access_token;
  const write = (await connect([linksWriteScope])).access_token;
  expect(await names(full.access_token)).toEqual([
    "delete_link",
    "list_links",
    "save_link",
  ]);
  expect(await names(read)).toEqual(["list_links"]);
  expect(await names(write)).toEqual(["delete_link", "save_link"]);

  const url = "https://example.com/";
  const saved = await useTool(write, "save_link", { url });
  const { link } = saved.result?.structuredContent as { link: { id: string } };
  expect((await useTool(read, "save_link", { url })).error).toBeDefined();
  expect(
    (await useTool(read, "delete_link", { id: link.id })).error,
  ).toBeDefined();
  expect((await useTool(write, "list_links")).error).toBeDefined();
  expect(
    (await useTool(read, "list_links")).result?.structuredContent,
  ).toMatchObject({ links: [link] });
  expect(
    (await useTool(write, "delete_link", { id: link.id })).result
      ?.structuredContent,
  ).toEqual({ id: link.id });

  const listGrants = async () => {
    const response = await call(mcpGrantsPath, undefined, session);
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(McpGrantList)(await response.json());
  };
  const grants = await listGrants();
  expect(grants).toHaveLength(3);
  for (const grant of grants) {
    expect(grant.createdAt).toBeGreaterThanOrEqual(connectedAfter);
    expect(grant.createdAt).toBeLessThanOrEqual(Date.now());
    expect(grant.expiresAt - grant.createdAt).toBe(30 * 86_400_000);
  }
  const refreshed = await form(mcpOAuth.paths.token, {
    grant_type: "refresh_token",
    client_id: codexClientId,
    resource,
    refresh_token: readGrant.refresh_token,
  });
  expect(refreshed.status, await refreshed.clone().text()).toBe(200);
  expect(await listGrants()).toEqual(grants);

  sqlite.run(
    `UPDATE yielded_oauth_server SET payload = json_set(payload, '$.authorization.scopes', json('["links:read-write","links:delete"]')) WHERE json_array_length(payload, '$.authorization.scopes') = 2`,
  );
  const old = await request("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${full.access_token}` },
  });
  expect(old.status).toBe(401);
  const refresh = await form(mcpOAuth.paths.token, {
    grant_type: "refresh_token",
    client_id: codexClientId,
    resource,
    refresh_token: full.refresh_token,
  });
  expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });
  expect(await listGrants()).toHaveLength(2);
});

it("verifies the signed-in address and changes the password with session invalidation", async () => {
  using sqlite = new Database(":memory:");
  const { call, signIn, cookies, messages, from, setEmailAvailable } =
    await setup(sqlite);
  const newPassword = "example test password phrase";
  const signInResponse = await signIn(password);
  expect(signInResponse.status, await signInResponse.text()).toBe(200);
  const session = cookies(signInResponse);
  const otherSession = cookies(await signIn(password));
  expect(
    await (await call("/api/me", undefined, session)).json(),
  ).toMatchObject({ email, emailVerified: false });
  expect((await call(emailVerificationPath, {})).status).toBe(401);
  expect(
    (await call(emailVerificationPath, {}, session, "https://another.example"))
      .status,
  ).toBe(403);

  const issued = await call(emailVerificationPath, {}, session);
  expect(issued.status, await issued.clone().text()).toBe(200);
  const challenge = (await issued.json()) as object;
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ from, to: email });
  const code = messages[0]?.text.match(/\b\d{6}\b/)?.[0];
  expect(code).toBeDefined();
  const verificationCookie = [session, cookies(issued)].join("; ");
  setEmailAvailable(false);
  const failedSend = await call(emailVerificationPath, {}, verificationCookie);
  expect(failedSend.status).toBe(503);
  expect(cookies(failedSend)).toBe("");
  setEmailAvailable(true);
  const mismatchedSession = [otherSession, cookies(issued)].join("; ");
  expect(
    (
      await call(
        `${emailVerificationPath}/confirm`,
        { ...challenge, code },
        mismatchedSession,
      )
    ).status,
  ).toBe(400);
  const verify = (code: string | undefined) =>
    call(
      `${emailVerificationPath}/confirm`,
      { ...challenge, code },
      verificationCookie,
    );
  expect((await verify(code === "000000" ? "111111" : "000000")).status).toBe(
    400,
  );
  const verified = await verify(code);
  expect(verified.status, await verified.text()).toBe(204);
  expect((await verify(code)).status).toBe(403);
  expect(
    await (await call("/api/me", undefined, session)).json(),
  ).toMatchObject({ email, emailVerified: true });

  const screening = vi.fn(
    async () => new Response("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:0"),
  );
  vi.stubGlobal("fetch", screening);
  try {
    expect(
      (
        await call(
          passwordChangePath,
          { currentPassword: "incorrect", newPassword },
          session,
        )
      ).status,
    ).toBe(400);
    expect(screening).not.toHaveBeenCalled();
    const changed = await call(
      passwordChangePath,
      { currentPassword: password, newPassword },
      session,
    );
    expect(changed.status, await changed.text()).toBe(204);
    expect(cookies(changed)).toContain("__Host-effect-auth-session=");
    expect(messages).toHaveLength(2);
    expect(messages[1]?.text).toContain("password was changed");
    expect((await call("/api/me", undefined, session)).status).toBe(401);
    expect((await call("/api/me", undefined, otherSession)).status).toBe(401);
    expect((await signIn(password)).status).toBe(400);
    expect((await signIn(newPassword)).status).toBe(200);
  } finally {
    vi.unstubAllGlobals();
  }
}, 20_000);

it("changes the sign-in address after password and code verification and keeps owner bootstrap idempotent", async () => {
  using sqlite = new Database(":memory:");
  const { call, signIn, cookies, messages, provision } = await setup(sqlite);
  const session = cookies(await signIn(password));
  const otherSession = cookies(await signIn(password));
  const newEmail = "new-owner@example.net";
  const savedUrl = "https://example.net/bookmark";
  expect((await call(linksPath, { url: savedUrl }, session)).ok).toBe(true);
  const start = (currentPassword: string) =>
    call(
      emailChangePath,
      { email: newEmail.toUpperCase(), currentPassword },
      session,
    );
  const confirm = (id: string, code: string, cookie = session) =>
    call(`${emailChangePath}/confirm`, { id, code }, cookie);

  expect((await start("incorrect")).status).toBe(400);
  expect(messages).toHaveLength(0);

  // Verify the old address first so the redirect also exercises an existing email credential.
  const issueVerification = await call(emailVerificationPath, {}, session);
  const originalCode = messages.pop()?.text.match(/\b\d{6}\b/)?.[0];
  expect(
    (
      await call(
        `${emailVerificationPath}/confirm`,
        { ...(await issueVerification.json()), code: originalCode },
        [session, cookies(issueVerification)].join("; "),
      )
    ).status,
  ).toBe(204);

  const request = await start(password);
  expect(request.status, await request.clone().text()).toBe(200);
  const change = (await request.json()) as { id: string; email: string };
  expect(change.email).toBe(newEmail);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.to).toBe(newEmail);
  const code = messages[0]?.text.match(/\b\d{6}\b/)?.[0] ?? "";
  expect(code).toHaveLength(6);
  expect((await signIn(password, newEmail)).status).toBe(400);
  expect((await signIn(password)).status).toBe(200);
  expect((await confirm(change.id, code, otherSession)).status).toBe(400);
  const wrongCode = code === "000000" ? "111111" : "000000";
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await confirm(change.id, wrongCode)).status).toBe(400);
  }
  expect((await confirm(change.id, code)).status).toBe(400);
  expect(messages).toHaveLength(1);

  const retried = await start(password);
  expect(retried.status).toBe(200);
  const { id } = (await retried.json()) as { id: string };
  const freshCode = messages[1]?.text.match(/\b\d{6}\b/)?.[0] ?? "";
  const outcomes = await Promise.all([
    confirm(id, freshCode),
    confirm(id, freshCode),
  ]);
  const changed = outcomes.find((response) => response.ok);
  expect(changed?.status).toBe(200);
  expect(await changed?.json()).toEqual({ oldAddressNotified: true });
  expect(outcomes.filter((response) => response.ok)).toHaveLength(1);
  expect(messages).toHaveLength(3);
  expect(messages[2]).toMatchObject({ to: email });
  expect(messages[2]?.text).toContain("sign-in email was changed");
  expect((await call("/api/me", undefined, session)).status).toBe(401);
  expect((await call("/api/me", undefined, otherSession)).status).toBe(401);
  expect((await signIn(password)).status).toBe(400);

  await expect(provision({})).resolves.toEqual({ ready: true });
  await expect(provision({ OWNER_EMAIL: email })).resolves.toEqual({
    ready: true,
  });
  const signedIn = await signIn(password, newEmail);
  expect(signedIn.status).toBe(200);
  const newSession = cookies(signedIn);
  expect(
    await (await call(linksPath, undefined, newSession)).json(),
  ).toMatchObject([{ url: savedUrl }]);
  expect(
    await (await call("/api/me", undefined, newSession)).json(),
  ).toMatchObject({
    id: "owner",
    email: newEmail,
    emailVerified: true,
  });
  expect(
    sqlite
      .query(
        "SELECT identifier_value FROM oneapp_auth_emailCredentials WHERE active = 1",
      )
      .get(),
  ).toEqual({ identifier_value: newEmail });
}, 20_000);

it("recovers only a verified address with a single-use link and revokes browser sessions", async () => {
  using sqlite = new Database(":memory:");
  const { call, signIn, cookies, messages, awaitDeliveries, from } =
    await setup(sqlite);
  const session = cookies(await signIn(password));
  const otherSession = cookies(await signIn(password));
  const requestReset = (address = email) =>
    call(passwordResetPath, { email: address });
  const completePath = `${passwordResetPath}/complete`;
  const newPassword = "example replacement password phrase";

  expect((await requestReset()).status).toBe(204);
  expect((await requestReset("unknown@example.net")).status).toBe(204);
  await awaitDeliveries();
  expect(messages).toHaveLength(0);

  const verification = await call(emailVerificationPath, {}, session);
  const code = messages.pop()?.text.match(/\b\d{6}\b/)?.[0];
  const verified = await call(
    `${emailVerificationPath}/confirm`,
    { ...(await verification.json()), code },
    [session, cookies(verification)].join("; "),
  );
  expect(verified.status).toBe(204);

  expect((await requestReset()).status).toBe(204);
  await awaitDeliveries();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ from, to: email });
  const findLink = (body: string) => {
    const link = body.match(/https:\/\/\S+/)?.[0];
    if (!link) throw new Error("Reset email did not include a link");
    return new URL(link);
  };
  const link = findLink(messages[0]!.text);
  expect(link.origin).toBe("https://oneapp.example");
  expect(link.pathname).toBe(resetPasswordPage);
  expect(link.search).toBe("");
  expect(link.hash).toMatch(/^#eal1\./);
  expect((await requestReset()).status).toBe(204);
  await awaitDeliveries();
  expect(messages).toHaveLength(1);

  const landing = await call(link.pathname);
  expect(landing.status).toBe(200);
  expect(landing.headers.get("cache-control")).toBe("no-store");
  expect(landing.headers.get("referrer-policy")).toBe("no-referrer");
  expect(landing.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  expect((await call("/api/me", undefined, session)).status).toBe(200);

  const bodyFor = async (url: URL) => {
    const { reference, secret } = await Effect.runPromise(
      EmailDelivery.parseLinkFragment(Redacted.make(url.hash)),
    );
    return { reference, secret: Redacted.value(secret), newPassword };
  };
  const expired = await bodyFor(link);
  sqlite.run(
    "UPDATE oneapp_auth_proofs SET expires_at = 0 WHERE purpose = 'password-reset'",
  );
  expect((await call(completePath, expired)).status).toBe(400);
  sqlite.run(
    "UPDATE oneapp_auth_proofs SET issued_at = 0 WHERE purpose = 'password-reset'",
  );
  expect((await requestReset()).status).toBe(204);
  await awaitDeliveries();

  const body = await bodyFor(findLink(messages[1]!.text));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:0")),
  );
  try {
    expect(
      (await call(completePath, body, undefined, "https://another.example"))
        .status,
    ).toBe(403);
    expect(
      (
        await call(completePath, {
          ...body,
          secret: (body.secret[0] === "A" ? "B" : "A") + body.secret.slice(1),
        })
      ).status,
    ).toBe(400);
    expect((await call("/api/me", undefined, session)).status).toBe(200);
    const outcome = await call(completePath, body);
    expect(outcome.status, await outcome.text()).toBe(204);
    expect((await call(completePath, body)).status).toBe(400);
    expect((await call("/api/me", undefined, session)).status).toBe(401);
    expect((await call("/api/me", undefined, otherSession)).status).toBe(401);
    expect((await signIn(password)).status).toBe(400);
    expect((await signIn(newPassword)).status).toBe(200);
  } finally {
    vi.unstubAllGlobals();
  }
}, 20_000);

it("scopes Bitwarden grants and login writes to the current account and vault", async () => {
  using sqlite = new Database(":memory:");
  const origin = "https://oneapp.example";
  const { request, signIn, cookies } = await setup(sqlite);
  const vaultId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  const otherVaultId = crypto.randomUUID();
  const keyId = "0".repeat(32);
  sqlite
    .query(
      "INSERT INTO accounts (id, active, security_revision) VALUES ('other', 1, '1')",
    )
    .run();
  const seedVault = sqlite.query(`
    INSERT INTO personal_vaults (id, owner_id, kdf_salt, kdf_iterations, wrapped_key, key_id,
       wrapped_private_key, public_key, created_at, revision_at)
    VALUES (?, ?, ?, 600000, 'wrapped', ?, 'wrapped-private', 'public', 1, 1)
  `);
  seedVault.run(vaultId, "owner", email, keyId);
  seedVault.run(otherVaultId, "other", "other@example.net", keyId);
  const seedLogin = sqlite.query(`
    INSERT INTO personal_vault_logins (id, vault_id, name, wrapped_key, details, created_at, revision_at)
    VALUES (?, ?, 'encrypted', 'wrapped', '{"credentials":{"username":"encrypted","password":"encrypted","uris":[{"uri":"encrypted","match":null}]}}', 1, 1)
  `);
  seedLogin.run(itemId, vaultId);
  const otherItemId = crypto.randomUUID();
  seedLogin.run(otherItemId, otherVaultId);

  const callback = `${origin}/sso-connector.html`;
  const verifier = "v".repeat(64);
  const challenge = Base64Url.encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const authorization = "/identity/connect/authorize";
  const authorize = `${authorization}?${new URLSearchParams({
    client_id: "browser",
    redirect_uri: callback,
    response_type: "code",
    scope: "api offline_access",
    state: `${"s".repeat(64)}:clientId=browser`,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })}`;
  const guest = await request(authorize, {});
  expect(guest.status).toBe(303);
  expect(
    new URL(guest.headers.get("location")!).searchParams.get(
      "connectBitwarden",
    ),
  ).toBe("1");

  const cookie = cookies(await signIn(password));
  const otherBrowser = cookies(await signIn(password));
  const page = await request(authorize, { headers: { cookie } });
  expect(page.status).toBe(200);
  const approval = (await page.text()).match(
    /name="approval" value="([^"]+)"/u,
  )?.[1];
  expect(approval).toBeDefined();

  const form = (
    path: string,
    body: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    request(path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(body),
    });
  const consent = { approval: approval! };
  expect(
    (
      await form(authorization, consent, {
        cookie,
        origin: "https://other.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (await form(authorization, consent, { cookie: otherBrowser, origin }))
      .status,
  ).toBe(400);
  const approved = await form(authorization, consent, { cookie, origin });
  expect(approved.status).toBe(303);
  const code = new URL(approved.headers.get("location")!).searchParams.get(
    "code",
  )!;

  const token = (body: Record<string, string>) =>
    form("/identity/connect/token", { client_id: "browser", ...body });
  const codeGrant = {
    grant_type: "authorization_code",
    code,
    redirect_uri: callback,
    deviceIdentifier: "test-device",
  };
  expect(
    (await token({ ...codeGrant, code_verifier: "x".repeat(64) })).status,
  ).toBe(400);
  const redemption = await Promise.all([
    token({ ...codeGrant, code_verifier: verifier }),
    token({ ...codeGrant, code_verifier: verifier }),
  ]);
  expect(redemption.map((response) => response.status).sort()).toEqual([
    200, 400,
  ]);
  const issued = (await redemption.find((response) => response.ok)!.json()) as {
    access_token: string;
    refresh_token: string;
  };
  const sync = (accessToken: string) =>
    request("/api/sync", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  const snapshot = (await (await sync(issued.access_token)).json()) as {
    ciphers: { id: string }[];
  };
  expect(snapshot.ciphers.map(({ id }) => id)).toEqual([itemId]);

  const encrypted = (bytes: number, fill = 0) => {
    const block = (length: number) =>
      Buffer.alloc(length, fill).toString("base64");
    return `2.${block(16)}|${block(bytes)}|${block(32)}`;
  };
  const login = {
    type: 1,
    encryptedFor: vaultId,
    encryptedByKeyId: keyId,
    name: encrypted(16),
    key: encrypted(80),
    notes: encrypted(16, 1),
    favorite: true,
    login: {
      password: encrypted(16, 2),
      uris: [
        { uri: encrypted(32, 3), match: null, uriChecksum: encrypted(48, 4) },
        { uri: encrypted(32, 5), match: 3 },
      ],
    },
  };
  const write = (accessToken: string, body: object, id?: string) =>
    request(id ? `/api/ciphers/${id}` : "/api/ciphers", {
      method: id ? "PUT" : "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
  const save = (accessToken: string, body: object = login) =>
    write(accessToken, body);
  expect((await save("unknown")).status).toBe(401);
  expect(
    (await save(issued.access_token, { ...login, encryptedFor: otherVaultId }))
      .status,
  ).toBe(400);
  expect(
    (
      await save(issued.access_token, {
        ...login,
        encryptedByKeyId: "1".repeat(32),
      })
    ).status,
  ).toBe(409);
  expect(
    (await save(issued.access_token, { ...login, name: "plaintext" })).status,
  ).toBe(400);
  expect(
    (
      await save(issued.access_token, {
        ...login,
        organizationId: otherVaultId,
      })
    ).status,
  ).toBe(400);
  const saves = await Promise.all([
    save(issued.access_token),
    save(issued.access_token),
  ]);
  expect(saves.map((response) => response.status)).toEqual([200, 200]);
  const created = (await saves[0]!.json()) as {
    id: string;
    creationDate: string;
    revisionDate: string;
    deletedDate: string | null;
  };
  expect(created).toMatchObject({
    name: login.name,
    key: login.key,
    notes: login.notes,
    favorite: true,
    login: login.login,
  });
  expect(await saves[1]!.json()).toEqual(created);
  expect(
    sqlite
      .query(
        "SELECT vault_id, revision_at FROM personal_vault_logins WHERE id = ?",
      )
      .get(created.id),
  ).toEqual({
    vault_id: vaultId,
    revision_at: Date.parse(created.revisionDate),
  });
  const revision = await request("/api/accounts/revision-date", {
    headers: { authorization: `Bearer ${issued.access_token}` },
  });
  expect(await revision.json()).toBe(Date.parse(created.revisionDate));
  const afterSave = (await (
    await sync(issued.access_token)
  ).json()) as typeof snapshot;
  expect(afterSave.ciphers.map(({ id }) => id).sort()).toEqual(
    [itemId, created.id].sort(),
  );

  const changed = {
    ...login,
    lastKnownRevisionDate: created.revisionDate,
    login: { ...login.login, password: encrypted(16, 6) },
  };
  const edit = (body: object = changed, id = created.id) =>
    write(issued.access_token, body, id);
  expect((await edit(login)).status).toBe(400);
  expect(
    (await edit({ ...changed, lastKnownRevisionDate: "invalid" })).status,
  ).toBe(400);
  expect((await edit(changed, otherItemId)).status).toBe(404);
  expect((await write("unknown", changed, created.id)).status).toBe(401);
  expect((await edit({ ...changed, encryptedFor: otherVaultId })).status).toBe(
    400,
  );
  const edits = await Promise.all([
    edit(),
    edit({ ...changed, login: { ...login.login, password: encrypted(16, 7) } }),
  ]);
  expect(edits.map((response) => response.status).sort()).toEqual([200, 409]);
  const winner = edits.findIndex((response) => response.ok);
  const edited = (await edits[winner]!.json()) as typeof created;
  expect(edited).toMatchObject({
    id: created.id,
    creationDate: created.creationDate,
    edit: true,
    organizationUseTotp: false,
    login: { ...login.login, password: encrypted(16, 6 + winner) },
  });
  expect(Date.parse(edited.revisionDate)).toBeGreaterThan(
    Date.parse(created.revisionDate),
  );
  expect(await edits[1 - winner]!.json()).toMatchObject({
    error: "stale_cipher",
  });
  expect(await (await save(issued.access_token)).json()).toEqual(edited);
  expect((await edit()).status).toBe(409);
  const afterEdit = (await (
    await sync(issued.access_token)
  ).json()) as typeof snapshot;
  expect(afterEdit.ciphers.find(({ id }) => id === created.id)).toEqual(edited);
  expect(
    sqlite
      .query("SELECT revision_at FROM personal_vaults WHERE id = ?")
      .get(vaultId),
  ).toEqual({ revision_at: Date.parse(edited.revisionDate) });

  const lifecycle = (
    action: "delete" | "restore",
    id = created.id,
    accessToken = issued.access_token,
  ) =>
    request(`/api/ciphers/${id}/${action}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  const readLogin = async () => {
    const snapshot = (await (await sync(issued.access_token)).json()) as {
      ciphers: (typeof created)[];
    };
    return snapshot.ciphers.find(({ id }) => id === created.id)!;
  };
  expect((await lifecycle("delete", otherItemId)).status).toBe(404);
  expect((await lifecycle("restore", otherItemId)).status).toBe(404);
  expect((await lifecycle("delete", created.id, "unknown")).status).toBe(401);
  expect(await (await lifecycle("restore")).json()).toEqual(edited);

  expect((await lifecycle("delete")).status).toBe(204);
  const trashed = await readLogin();
  expect(trashed).toEqual({
    ...edited,
    deletedDate: trashed.revisionDate,
    revisionDate: trashed.revisionDate,
    permissions: { delete: false, restore: true },
  });
  expect(Date.parse(trashed.revisionDate)).toBeGreaterThan(
    Date.parse(edited.revisionDate),
  );
  expect((await lifecycle("delete")).status).toBe(204);
  expect(await (await save(issued.access_token)).json()).toEqual(trashed);
  for (const revision of [edited.revisionDate, trashed.revisionDate]) {
    const rejected = await edit({
      ...changed,
      lastKnownRevisionDate: revision,
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: "cipher_trashed" });
  }
  expect(await readLogin()).toEqual(trashed);
  expect(
    sqlite
      .query("SELECT revision_at FROM personal_vaults WHERE id = ?")
      .get(vaultId),
  ).toEqual({ revision_at: Date.parse(trashed.revisionDate) });

  const restore = await lifecycle("restore");
  expect(restore.status).toBe(200);
  const restored = (await restore.json()) as typeof created;
  expect(restored).toEqual({ ...edited, revisionDate: restored.revisionDate });
  expect(Date.parse(restored.revisionDate)).toBeGreaterThan(
    Date.parse(trashed.revisionDate),
  );
  expect(await (await lifecycle("restore")).json()).toEqual(restored);
  expect(
    (await edit({ ...changed, lastKnownRevisionDate: edited.revisionDate }))
      .status,
  ).toBe(409);
  expect(await readLogin()).toEqual(restored);
  expect(
    sqlite
      .query("SELECT revision_at FROM personal_vaults WHERE id = ?")
      .get(vaultId),
  ).toEqual({ revision_at: Date.parse(restored.revisionDate) });

  const refresh = {
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
  };
  const rotated = await Promise.all([token(refresh), token(refresh)]);
  expect(rotated.map((response) => response.status)).toEqual([200, 200]);
  const successor = (await rotated[0]!.json()) as typeof issued;
  expect(
    ((await rotated[1]!.json()) as typeof issued).refresh_token ===
      successor.refresh_token,
  ).toBe(true);
  expect(successor.refresh_token !== issued.refresh_token).toBe(true);
  expect((await sync(successor.access_token)).status).toBe(200);
  expect((await request("/api/sync", { method: "POST" })).status).toBe(405);
  sqlite.query("UPDATE bitwarden_device_sessions SET retry_until = 0").run();
  expect((await sync(issued.access_token)).status).toBe(401);
  expect((await token(refresh)).status).toBe(400);

  sqlite
    .query(
      "UPDATE accounts SET security_revision = 'changed' WHERE id = 'owner'",
    )
    .run();
  expect((await sync(successor.access_token)).status).toBe(401);
  expect((await save(successor.access_token)).status).toBe(401);
  expect(
    (await lifecycle("restore", created.id, successor.access_token)).status,
  ).toBe(401);
  expect(
    (await write(successor.access_token, changed, created.id)).status,
  ).toBe(401);
  expect(
    (await token({ ...refresh, refresh_token: successor.refresh_token }))
      .status,
  ).toBe(400);
  expect((await token(refresh)).status).toBe(400);
});

it("initializes a personal vault once and preserves its keys on retries and concurrent setup", async () => {
  using sqlite = new Database(":memory:");
  const { call, cookies, signIn } = await setup(sqlite);
  const [first, second] = await Promise.all([
    createVaultSetup("first test vault password", email),
    createVaultSetup("second test vault password", email),
  ]);
  expect((await call(vaultSetupPath)).status).toBe(401);
  expect((await call(vaultSetupPath, first)).status).toBe(401);

  const cookie = cookies(await signIn(password));
  expect(await (await call(vaultSetupPath, undefined, cookie)).json()).toEqual({
    initialized: false,
    kdfSalt: email,
  });
  expect(
    (await call(vaultSetupPath, first, cookie, "https://other.example")).status,
  ).toBe(403);
  expect(
    (
      await call(
        vaultSetupPath,
        { ...first, kdfSalt: "other@example.net" },
        cookie,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call(
        vaultSetupPath,
        { ...first, masterPassword: "unexpected" },
        cookie,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        vaultSetupPath,
        { ...first, publicKey: "A".repeat(392) },
        cookie,
      )
    ).status,
  ).toBe(400);

  const [left, right] = await Promise.all([
    call(vaultSetupPath, first, cookie),
    call(vaultSetupPath, second, cookie),
  ]);
  expect([left.status, right.status].sort()).toEqual([201, 409]);
  const winner = left.status === 201 ? first : second;
  const loser = left.status === 201 ? second : first;
  expect((await call(vaultSetupPath, winner, cookie)).status).toBe(204);
  expect((await call(vaultSetupPath, loser, cookie)).status).toBe(409);
  expect(await (await call(vaultSetupPath, undefined, cookie)).json()).toEqual({
    initialized: true,
  });

  const vaults = sqlite
    .query("SELECT owner_id, key_id, wrapped_key FROM personal_vaults")
    .all();
  expect(vaults).toEqual([
    { owner_id: "owner", key_id: winner.keyId, wrapped_key: winner.wrappedKey },
  ]);
  expect(sqlite.query("SELECT id FROM personal_vault_logins").all()).toEqual(
    [],
  );
});
