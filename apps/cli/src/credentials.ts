import { CliTokenSecret } from "@orumai/core/cli-auth";
import { Effect, Redacted, Schema } from "effect";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors.ts";

const service = "oneapp-cli";
const isToken = Schema.is(CliTokenSecret);
const configDirectory = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "oneapp",
);
const configPath = join(configDirectory, "config.json");

export const serverOrigin = (input: string) => {
  if (!/^https?:\/\//i.test(input))
    throw new Error("Use an HTTP or HTTPS server origin.");
  const url = new URL(input);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Use an HTTPS server origin, or HTTP for localhost.");
  }
  return url.origin;
};

export const credentials = Effect.gen(function* () {
  const origin = yield* Effect.tryPromise({
    try: async () => {
      const raw = await readFile(configPath, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (raw === null) return null;
      const config = Schema.decodeUnknownSync(
        Schema.Struct({ origin: Schema.String }),
      )(JSON.parse(raw));
      return serverOrigin(config.origin);
    },
    catch: () =>
      new CliError({
        message:
          "Could not read the Orumai server setting. Run one auth login again.",
      }),
  });
  if (!origin)
    return yield* new CliError({
      message: "Run one auth login first.",
    });

  const token = yield* Effect.tryPromise({
    try: () => Bun.secrets.get({ service, name: origin }),
    catch: () =>
      new CliError({
        message: "Could not read the token from your OS credential store.",
      }),
  });
  if (!isToken(token))
    return yield* new CliError({
      message: "No CLI token is saved. Run one auth login again.",
    });
  return { origin, token: Redacted.make(token) };
});

export const storeCredentials = Effect.fnUntraced(function* (
  origin: string,
  token: Redacted.Redacted<string>,
) {
  const temporary = join(configDirectory, `config-${crypto.randomUUID()}.tmp`);
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(configDirectory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify({ origin }), {
        mode: 0o600,
        flag: "wx",
      });
    },
    catch: () =>
      new CliError({ message: "Could not write the Orumai server setting." }),
  });

  yield* Effect.tryPromise({
    try: async () => {
      try {
        await Bun.secrets.set({
          service,
          name: origin,
          value: Redacted.value(token),
          persist: "local",
        });
      } catch {
        throw new CliError({
          message: "Could not save the token in your OS credential store.",
        });
      }
      try {
        await rename(temporary, configPath);
      } catch {
        throw new CliError({
          message:
            "The token was saved, but the server setting could not be updated. Run one auth login again.",
        });
      }
    },
    catch: (error) =>
      error instanceof CliError
        ? error
        : new CliError({ message: "Could not save CLI credentials." }),
  }).pipe(
    Effect.ensuring(
      Effect.promise(() => rm(temporary, { force: true }).catch(() => {})),
    ),
  );
});

export const clearToken = (origin: string) =>
  Effect.tryPromise({
    try: () => Bun.secrets.delete({ service, name: origin }),
    catch: () =>
      new CliError({
        message:
          "The token was revoked, but it could not be removed from your OS credential store.",
      }),
  });
