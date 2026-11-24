import { join } from "node:path";
import { parseArgs } from "node:util";
import { Schema } from "effect";
import {
  currentDevStage,
  defaultDevStage,
  devConfigPath,
  isRestoredStage,
  prepareDev,
  StageName,
  startDev,
  usesDefaultDev,
} from "./dev-local.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    stage: { type: "string", default: defaultDevStage },
    port: { type: "string", default: "1337" },
  },
});
let stage = Schema.decodeUnknownSync(StageName)(values.stage);
const defaultStage = usesDefaultDev(stage);
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Choose a local port between 1024 and 65535.");

if (defaultStage) {
  let current = await currentDevStage();
  if (!current) {
    console.log("Preparing local dev from the latest production backup.");
    const pull = Bun.spawn(
      [process.execPath, join(import.meta.dir, "dev-pull.ts")],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
    const exit = await pull.exited;
    if (exit !== 0) process.exit(exit);
    current = await currentDevStage();
  }
  if (!current) throw new Error("Run bun run dev:pull to prepare local dev.");
  stage = current;
}

const config = devConfigPath(stage);
if (isRestoredStage(stage)) {
  if (!(await Bun.file(config).exists()))
    throw new Error(
      "The local snapshot credentials are missing. Run bun run dev:pull again.",
    );
} else {
  await prepareDev(stage);
}

console.log(
  `Starting local ${defaultStage ? defaultDevStage : stage}. Sign-in credentials are in ${config}.`,
);
const child = startDev(stage, port, config, true);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal));
process.exitCode = await child.exited;
