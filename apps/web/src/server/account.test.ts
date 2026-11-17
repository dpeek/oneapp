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
import { ConfigProvider, Effect, Redacted } from "effect";
import { Base64Url } from "effect/encoding";
import type { WorkerEnv } from "../../../../alchemy.run.ts";
import {
  emailChangePath,
  emailVerificationPath,
  passwordChangePath,
} from "../account-contract.ts";
import { codexClientId, mcpGrantsPath } from "../mcp-access-contract.ts";
import {
  passwordResetPath,
  resetPasswordPage,
} from "../password-recovery-contract.ts";
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

  const issued = await call(
    cliTokensPath,
    { label: "Mac mini", scopes: cliLinkScopes },
    session,
  );
  expect(issued.status).toBe(201);
  const manual = (await issued.json()) as {
    secret: string;
    token: { id: string };
  };
  const save = await credential(secret, linksPath, "POST", {
    url: "https://example.com/",
  });
  expect(save.status).toBe(201);
  const link = (await save.json()) as { id: string };
  expect(
    await (await credential(manual.secret, linksPath)).json(),
  ).toMatchObject([link]);

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
    manual.token.id,
  ]);
  expect((await credential(manual.secret, linksPath)).status).toBe(403);
  expect(
    (await credential(manual.secret, linkPath(link.id), "DELETE")).status,
  ).toBe(204);

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

  const full = await connect();
  const read = (await connect([linksReadScope])).access_token;
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
  expect(
    await (await call(mcpGrantsPath, undefined, session)).json(),
  ).toHaveLength(2);
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
