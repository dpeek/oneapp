#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { appName, defaultServerUrl } from "@orumai/core";
import {
  cliMailImportScopes,
  currentCliTokenPath,
} from "@orumai/core/cli-auth";
import {
  Link,
  LinkId,
  LinkList,
  SaveLink,
  linkPath,
  linksPath,
} from "@orumai/core/links";
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
import { browserLogin } from "./login.ts";
import { version } from "../package.json";

const terminalUrl = (url: string) =>
  url.replace(/\p{Cc}/gu, (character) => encodeURIComponent(character));

const login = Command.make(
  "login",
  {
    server: Flag.String("server").pipe(
      Flag.withDefault(defaultServerUrl),
      Flag.withDescription(
        `Orumai server origin (default: ${defaultServerUrl})`,
      ),
    ),
    browser: Flag.Boolean("browser").pipe(
      Flag.withDefault(true),
      Flag.withDescription("Open the Orumai access page"),
    ),
    mailImport: Flag.Boolean("mail-import").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Request mail import access for 24 hours instead of Links access",
      ),
    ),
    name: Flag.String("name").pipe(
      Flag.withDefault("Orumai CLI"),
      Flag.withDescription("Name to show under CLI access"),
    ),
  },
  Effect.fnUntraced(function* ({ server, browser, name, mailImport }) {
    const origin = yield* Effect.try({
      try: () => serverOrigin(server),
      catch: () =>
        new CliError({
          message: "Use an HTTPS server origin, or HTTP for localhost.",
        }),
    });
    const token = yield* browserLogin(
      origin,
      browser,
      name,
      mailImport ? cliMailImportScopes : undefined,
    );
    yield* storeCredentials(origin, token);
    yield* Console.log(`Signed in to ${origin}`);
  }),
).pipe(Command.withDescription("Connect the CLI to your Orumai account"));

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
  {
    ids: Flag.Boolean("ids").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Include the ID used by oru links delete"),
    ),
  },
  Effect.fnUntraced(function* ({ ids }) {
    const { origin, token } = yield* credentials;
    const response = yield* request(origin, token, linksPath);
    yield* requireSuccess(response);
    const links = yield* readResponse(LinkList, response);
    if (links.length === 0) yield* Console.log("No saved links.");
    for (const link of links)
      yield* Console.log(
        `${ids ? `${link.id}  ` : ""}${new Date(link.savedAt).toISOString()}  ${terminalUrl(link.url)}`,
      );
  }),
).pipe(Command.withDescription("List saved links, newest first"));

const deleteLink = Command.make(
  "delete",
  { id: Argument.String("id").pipe(Argument.withSchema(LinkId)) },
  Effect.fnUntraced(function* ({ id }) {
    const { origin, token } = yield* credentials;
    const response = yield* request(origin, token, linkPath(id), {
      method: "DELETE",
    });
    if (response.status === 404)
      return yield* new CliError({ message: "Link not found." });
    if (response.status === 403)
      return yield* new CliError({
        message:
          "Run oru auth login again to grant permission to delete links.",
      });
    yield* requireSuccess(response);
    yield* Console.log(`Deleted ${id}`);
  }),
).pipe(Command.withDescription("Delete a saved link by ID"));

const auth = Command.make("auth").pipe(
  Command.withDescription("Manage CLI access"),
  Command.withSubcommands([login, logout]),
);
const links = Command.make("links").pipe(
  Command.withDescription("Manage saved links"),
  Command.withSubcommands([add, list, deleteLink]),
);

Command.make("oru").pipe(
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
