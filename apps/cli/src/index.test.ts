import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { fileURLToPath } from "node:url";

it.effect("the CLI entry point runs from the workspace", () =>
  Effect.sync(() => {
    const entryPoint = fileURLToPath(new URL("./index.ts", import.meta.url));
    const result = Bun.spawnSync([process.execPath, entryPoint], {
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("OneApp");
  }),
);
