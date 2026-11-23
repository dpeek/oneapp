import { mkdir, chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Schema } from "effect";
import { localDirectory, StageName } from "./mail/local.ts";

// A separate local stage avoids accidentally inheriting live routing or
// sending configuration from the deployment environment.
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    stage: { type: "string", default: "mail_sample" },
    port: { type: "string", default: "1337" },
  },
});
const stage = Schema.decodeUnknownSync(StageName)(values.stage);
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Choose a local port between 1024 and 65535.");
const config = join(
  localDirectory,
  stage === "mail_sample" ? "mail-sample.env" : `${stage}.env`,
);
await mkdir(localDirectory, { recursive: true, mode: 0o700 });
const secret = () =>
  crypto
    .getRandomValues(new Uint8Array(32))
    .toBase64({ alphabet: "base64url", omitPadding: true });
try {
  await writeFile(
    config,
    [
      "OWNER_EMAIL=mail@dpeek.com",
      `OWNER_PASSWORD=${secret()}`,
      `AUTH_SECRET=${secret()}`,
      `MCP_OAUTH_SECRET=${secret()}`,
      "",
    ].join("\n"),
    { flag: "wx", mode: 0o600 },
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
}
await chmod(config, 0o600);
console.log(`Starting local ${stage}. Sign-in credentials are in ${config}.`);
const env = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "TERM", "COLORTERM", "USER", "SHELL"].flatMap(
    (key) => (process.env[key] ? [[key, process.env[key]!]] : []),
  ),
);
const child = Bun.spawn(
  [
    "node",
    "node_modules/alchemy/bin/cli.js",
    "dev",
    "--stage",
    stage,
    "--env-file",
    config,
  ],
  {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...env,
      ONEAPP_DEV_PORT: String(port),
      MAILBOX_ALIASES: "mail@dpeek.com",
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal));
process.exitCode = await child.exited;
