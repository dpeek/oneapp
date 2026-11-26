import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { stopProcessGroup } from "./processes.ts";

it.skipIf(process.platform !== "darwin").each([false, true])(
  "checks for live group members after EPERM (live: %s)",
  async (live) => {
    const child = { pid: 1234 } as ReturnType<typeof Bun.spawn>;
    const denied = Object.assign(new Error("kill: operation not permitted"), {
      code: "EPERM",
    });
    const signal = vi.spyOn(process, "kill").mockImplementation(() => {
      throw denied;
    });
    const ps = vi.spyOn(Bun, "spawnSync").mockReturnValue({
      exitCode: 0,
      stdout: Buffer.from(` 1230 S\n 1234 ${live ? "S" : "Z"}+\n`),
    } as ReturnType<typeof Bun.spawnSync>);

    try {
      const stop = stopProcessGroup(child);
      if (live) await expect(stop).rejects.toBe(denied);
      else await expect(stop).resolves.toBeUndefined();
      expect(signal).toHaveBeenCalledWith(-child.pid, "SIGINT");
      expect(ps).toHaveBeenCalledWith(["/bin/ps", "-ax", "-o", "pgid=,stat="], {
        stderr: "ignore",
      });
    } finally {
      signal.mockRestore();
      ps.mockRestore();
    }
  },
);
