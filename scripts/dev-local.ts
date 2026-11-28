import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";

export const localDirectory = join(import.meta.dir, "..", ".alchemy");
export const defaultDevStage = "dev";
export const StageName = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/u),
);
export const devState = join(localDirectory, "dev-pull");
export const devPointer = join(devState, "current.json");
// Previously restored stages can still be selected by the current pointer.
export const isRestoredStage = (stage: string) =>
  /^(?:dev|prod_snapshot)_[a-f0-9]{12}$/u.test(stage);
export const usesDefaultDev = (stage: string) =>
  stage === defaultDevStage || stage === "prod_snapshot";

export const currentDevStage = async () => {
  const pointer = await readFile(devPointer, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (pointer === undefined) return undefined;
  const parsed: unknown = JSON.parse(pointer);
  const stage =
    typeof parsed === "object" && parsed !== null && "stage" in parsed
      ? parsed.stage
      : undefined;
  if (typeof stage !== "string" || !isRestoredStage(stage))
    throw new Error(
      "The local dev stage is invalid. Run bun run dev:pull again.",
    );
  return stage;
};

export const devConfigPath = (stage: string) =>
  join(
    localDirectory,
    stage === "mail_sample" ? "mail-sample.env" : stage + ".env",
  );

const secret = () =>
  crypto.getRandomValues(new Uint8Array(32)).toBase64({
    alphabet: "base64url",
    omitPadding: true,
  });

export const prepareDev = async (
  stage: string,
  email = "owner@orumai.test",
) => {
  if (/[\r\n"\\]/u.test(email))
    throw new Error(
      "The owner email cannot be written to a local environment file.",
    );
  await mkdir(localDirectory, { recursive: true, mode: 0o700 });
  const config = devConfigPath(stage);
  const password = secret();
  try {
    await writeFile(
      config,
      [
        "OWNER_EMAIL=" + JSON.stringify(email),
        "OWNER_PASSWORD=" + password,
        "AUTH_SECRET=" + secret(),
        "MCP_OAUTH_SECRET=" + secret(),
        "",
      ].join("\n"),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (
      isRestoredStage(stage) ||
      (error as NodeJS.ErrnoException).code !== "EEXIST"
    )
      throw error;
  }
  await chmod(config, 0o600);
  return { config, password };
};

export const startDev = (
  stage: string,
  port: number,
  config: string,
  interactive: boolean,
) => {
  // Local workers must use local credentials and services, including on a
  // machine with production settings in its shell environment.
  const env = Object.fromEntries(
    [
      "PATH",
      "HOME",
      "TMPDIR",
      "TERM",
      "COLORTERM",
      "USER",
      "SHELL",
      "ALCHEMY_HOME",
      "XDG_STATE_HOME",
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
  );
  return Bun.spawn(
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
        ...(isRestoredStage(stage) ? { ONEAPP_DEV_SNAPSHOT: "true" } : {}),
      },
      stdin: interactive ? "inherit" : "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
};
