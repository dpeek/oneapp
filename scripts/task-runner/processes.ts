import { setTimeout } from "node:timers/promises";

export async function stopProcessGroup(child: ReturnType<typeof Bun.spawn>) {
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stop = Bun.spawn(
      ["taskkill", "/PID", String(child.pid), "/T", "/F"],
      {
        stdout: "ignore",
        stderr: "inherit",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (
      (await stop.exited) !== 0 &&
      child.exitCode === null &&
      child.signalCode === null
    )
      throw new Error(`Could not stop the process tree (${child.pid}).`);
    await child.exited;
    return;
  }

  const signalGroup = (signal: NodeJS.Signals | 0) => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  // The launcher can exit before its children.
  for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"] as const) {
    if (!signalGroup(signal)) return;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!signalGroup(0)) return;
      await setTimeout(150);
    }
  }
  throw new Error(`Process group ${child.pid} did not exit.`);
}
