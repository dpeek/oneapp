import { cloudflareEnvironment } from "./cloudflare-env.ts";

const env = await cloudflareEnvironment();

const build = Bun.spawn(
  [process.execPath, "run", "--filter", "@orumai/web", "build"],
  {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
const buildExit = await build.exited;
if (buildExit !== 0) process.exit(buildExit);

const deploy = Bun.spawn(
  [process.execPath, "run", "alchemy", "deploy", ...process.argv.slice(2)],
  {
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exitCode = await deploy.exited;
