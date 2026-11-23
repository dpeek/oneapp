import { cloudflareEnvironment } from "./cloudflare-env.ts";

const child = Bun.spawn(
  [process.execPath, "run", "alchemy", ...process.argv.slice(2)],
  {
    env: await cloudflareEnvironment(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exitCode = await child.exited;
