#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { appName, defaultServerUrl } from "@oneapp/core";
import { CliTokenSecret, currentCliTokenPath } from "@oneapp/core/cli-auth";
import { Link, LinkList, SaveLink, linksPath } from "@oneapp/core/links";
import { Console, Effect, Redacted, Schema } from "effect";
import { Argument, Command, Flag, Prompt } from "effect/cli";
import { readResponse, request, requireSuccess } from "./api.ts";
import {
  clearToken,
  credentials,
  serverOrigin,
  storeCredentials,
} from "./credentials.ts";
import { CliError } from "./errors.ts";
import { version } from "../package.json";

const isToken = Schema.is(CliTokenSecret);
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
  },
  Effect.fnUntraced(function* ({ server, browser }) {
    if (!process.stdin.isTTY)
      return yield* new CliError({
        message: "Run one auth login in an interactive terminal.",
      });
    const origin = yield* Effect.try({
      try: () => serverOrigin(server),
      catch: () =>
        new CliError({
          message: "Use an HTTPS server origin, or HTTP for localhost.",
        }),
    });
    const accessUrl = `${origin}/#cli-access`;
    yield* Console.log(`Create a CLI token under CLI access at ${accessUrl}`);
    if (browser) {
      yield* Effect.sync(() => {
        const opener =
          process.platform === "darwin"
            ? ["open"]
            : process.platform === "win32"
              ? ["rundll32.exe", "url.dll,FileProtocolHandler"]
              : ["xdg-open"];
        try {
          Bun.spawn([...opener, accessUrl], {
            stdout: "ignore",
            stderr: "ignore",
          }).unref();
        } catch {
          // The URL is already available if a browser opener is unavailable.
        }
      });
    }
    const entered = yield* Prompt.Hidden({ message: "Paste the CLI token" });
    const value = Redacted.value(entered).trim();
    if (!isToken(value))
      return yield* new CliError({
        message: "Paste the CLI token created in OneApp.",
      });
    const token = Redacted.make(value);
    const response = yield* request(origin, token, currentCliTokenPath);
    yield* requireSuccess(response);
    yield* storeCredentials(origin, token);
    yield* Console.log(`Signed in to ${origin}`);
  }),
).pipe(
  Command.withDescription(
    "Save a OneApp CLI token in your OS credential store",
  ),
);

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
