export type WorkflowResult = { exitCode: number; message: string };

if (import.meta.main) {
  try {
    const [, , command, summary, ...extra] = process.argv;
    if (
      (command !== "fetch" && command !== "verify" && command !== "publish") ||
      (summary !== undefined && command !== "publish") ||
      extra.length
    )
      throw new Error(
        "Usage: workflow-client.ts fetch | verify | publish [summary]",
      );
    const endpoint = process.env.ORUMAI_WORKFLOW_URL;
    const session = process.env.ORUMAI_WORKFLOW_SESSION;
    if (!endpoint || !session)
      throw new Error("This command requires an active task runner session.");
    const result: WorkflowResult = await fetch(new URL(command, endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${session}` },
      body: summary,
      redirect: "error",
    }).then((response) => response.json());
    (result.exitCode === 0 ? console.log : console.error)(result.message);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
