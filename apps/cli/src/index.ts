#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { appName, defaultServerUrl } from "@oneapp/core";
import { currentCliTokenPath } from "@oneapp/core/cli-auth";
import { Link, LinkList, SaveLink, linksPath } from "@oneapp/core/links";
import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { readResponse, request, requireSuccess } from "./api.ts";
import {
  clearToken,
  credentials,
  serverOrigin,
  storeCredentials,
} from "./credentials.ts";
import { CliError } from "./errors.ts";
import { browserLogin, manualLogin } from "./login.ts";
import { version } from "../package.json";

const terminalUrl = (url: string) =>
  url.replace(/\p{Cc}/gu, (character) => encodeURIComponent(character));

const login = Command.make(
  "login",
  {
    server: Flag.String("server").pipe(
      Flag.withDefault(defaultServerUrl),
      Flag.withDescription(
        `OneApp server origin (default: ${defaultServerUrl})`,
      ),
    ),
    browser: Flag.Boolean("browser").pipe(
      Flag.withDefault(true),
      Flag.withDescription("Open the OneApp access page"),
    ),
    manualToken: Flag.Boolean("manual-token").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Paste a token created in OneApp instead"),
    ),
    name: Flag.String("name").pipe(
      Flag.withDefault("OneApp CLI"),
      Flag.withDescription("Name to show under CLI access"),
    ),
  },
  Effect.fnUntraced(function* ({ server, browser, manualToken, name }) {
    const origin = yield* Effect.try({
      try: () => serverOrigin(server),
      catch: () =>
        new CliError({
          message: "Use an HTTPS server origin, or HTTP for localhost.",
        }),
    });
    const token = yield* manualToken
      ? manualLogin(origin, browser)
      : browserLogin(origin, browser, name);
    yield* storeCredentials(origin, token);
    yield* Console.log(`Signed in to ${origin}`);
  }),
).pipe(Command.withDescription("Connect the CLI to your OneApp account"));

const logout = Command.make(
  "logout",
  {},
  Effect.fnUntraced(function* () {
    const { origin, token } = yield* credentials;
    const response = yield* request(origin, token, currentCliTokenPath, {
      method: "DELETE",
    });
    if (response.status !== 401) yield* requireSuccess(response);
    yield* clearToken(origin);
    yield* Console.log(`Signed out of ${origin}`);
  }),
).pipe(
  Command.withDescription(
    "Revoke the active CLI token and clear it from this device",
  ),
);

const add = Command.make(
  "add",
  {
    url: Argument.String("url").pipe(Argument.withSchema(SaveLink.fields.url)),
  },
  Effect.fnUntraced(function* ({ url }) {
    const { origin, token } = yield* credentials;
    const response = yield* request(origin, token, linksPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    yield* requireSuccess(response);
    const link = yield* readResponse(Link, response);
    yield* Console.log(`Saved ${terminalUrl(link.url)}`);
  }),
).pipe(Command.withDescription("Save a link"));

const list = Command.make(
  "list",
  {},
  Effect.fnUntraced(function* () {
    const { origin, token } = yield* credentials;
    const response = yield* request(origin, token, linksPath);
    yield* requireSuccess(response);
    const links = yield* readResponse(LinkList, response);
    if (links.length === 0) yield* Console.log("No saved links.");
    for (const link of links)
      yield* Console.log(
        `${new Date(link.savedAt).toISOString()}  ${terminalUrl(link.url)}`,
      );
  }),
).pipe(Command.withDescription("List saved links, newest first"));

const auth = Command.make("auth").pipe(
  Command.withDescription("Manage CLI access"),
  Command.withSubcommands([login, logout]),
);
const links = Command.make("links").pipe(
  Command.withDescription("Manage saved links"),
  Command.withSubcommands([add, list]),
);

Command.make("one").pipe(
  Command.withDescription(appName),
  Command.withSubcommands([auth, links]),
  Command.run({ version }),
  Effect.provide(BunServices.layer),
  Effect.catchTag("CliError", (error) =>
    Console.error(error.message).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      ),
    ),
  ),
  BunRuntime.runMain,
);
