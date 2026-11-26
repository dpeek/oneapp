import { constants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Schema } from "effect";

const configPath = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "orumai-task-runner",
  "config.json",
);
const Config = Schema.fromJsonString(
  Schema.Struct({ chromeHeadlessShell: Schema.String }),
);

const validateBrowser = async (path: string) => {
  if (!isAbsolute(path))
    throw new Error("The Chrome Headless Shell path must be absolute.");
  try {
    await access(path, constants.X_OK);
    if (!(await stat(path)).isFile()) throw new Error("Expected a file.");
  } catch {
    throw new Error(
      `Chrome Headless Shell is not executable at ${path}. Run tasks:runner --configure-browser <path>.`,
    );
  }
  return path;
};

export async function configureBrowser(input: string) {
  const chromeHeadlessShell = await validateBrowser(resolve(input));
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ chromeHeadlessShell }) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, configPath);
  } finally {
    await rm(temporary, { force: true });
  }
  return chromeHeadlessShell;
}

export async function resolveBrowser() {
  const override = process.env.ORUMAI_CHROME_HEADLESS_SHELL;
  if (override) return validateBrowser(override);

  const saved = await readFile(configPath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  const executable =
    saved === undefined
      ? Bun.which("chrome-headless-shell")
      : Schema.decodeUnknownSync(Config)(saved).chromeHeadlessShell;
  if (!executable)
    throw new Error(
      "Configure Chrome Headless Shell with tasks:runner --configure-browser <path>.",
    );
  return validateBrowser(executable);
}
