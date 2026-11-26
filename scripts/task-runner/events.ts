import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { taskPath } from "../../apps/web/src/tasks-contract.ts";

export async function recordRunEvent(
  run: string,
  taskId: string,
  origin: string,
  phase: string,
  detail: Record<string, unknown> = {},
) {
  const event = JSON.stringify({
    at: new Date().toISOString(),
    taskId,
    url: new URL(taskPath(taskId), origin).href,
    phase,
    ...detail,
  });
  await appendFile(join(run, "run.jsonl"), event + "\n", { mode: 0o600 });
  console.log(event);
}
