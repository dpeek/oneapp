import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { stopProcessGroup } from "./processes.ts";

it.skipIf(process.platform !== "darwin").each([false, true])(
  "checks for live group members after EPERM (live: %s)",
  async (live) => {
    const child = Bun.spawn(["/bin/sleep", "30"], { detached: true });
    if (!live) {
      child.kill();
      await child.exited;
    }

    const denied = Object.assign(new Error("kill: operation not permitted"), {
      code: "EPERM",
    });
    const kill = process.kill.bind(process);
    const signal = vi.spyOn(process, "kill").mockImplementation((pid, value) => {
      if (pid === -child.pid) throw denied;
      return kill(pid, value);
    });

    try {
      const stop = stopProcessGroup(child);
      if (live) await expect(stop).rejects.toBe(denied);
      else await expect(stop).resolves.toBeUndefined();
    } finally {
      signal.mockRestore();
      if (live) child.kill();
      await child.exited;
    }
  },
);
