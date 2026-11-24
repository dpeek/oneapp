import { openLocalMailSink } from "./mail/local-sink.ts";
import { MailboxId } from "../apps/web/src/server/mailbox.ts";
import { mkdir, chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Redacted, Schema } from "effect";
import { ImapFlow } from "imapflow";
import { inventoryCredentials } from "./mail/config.ts";
import { inventoryErrorMessage, MailSampleError } from "./mail/errors.ts";
import { localDirectory } from "./dev-local.ts";
import { localMailResources, resolveMailStage } from "./mail/local.ts";
import {
  planSample,
  runSample,
  SamplePlan,
  sampleFolders,
  sampleLimits,
} from "./mail/sample.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    stage: { type: "string", default: "mail_sample" },
    mailbox: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "bun run mail:sample --mailbox <mailbox-id> [--stage mail_sample]\nRequires a running local Alchemy stage and ICLOUD_IMAP_USER / ICLOUD_IMAP_PASSWORD in .env.\nSelects recent messages and related threads from Inbox, Sent Messages and Archive; at most 100 messages / 100 MiB. Reuses the saved plan on rerun.",
  );
  process.exit(0);
}

let phase = "local storage";
try {
  const stage = await resolveMailStage(values.stage);
  const resources = await localMailResources(stage);
  const mailboxId = Schema.decodeUnknownSync(MailboxId)(values.mailbox);
  const credentials = inventoryCredentials(undefined, process.env);
  if (!credentials.user || !credentials.password)
    throw new MailSampleError(
      "Set ICLOUD_IMAP_USER and ICLOUD_IMAP_PASSWORD in .env.",
    );
  const account = `icloud:${credentials.user.toLowerCase()}`;
  const directory = join(localDirectory, "mail-import", stage, mailboxId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const planPath = join(directory, "plan.json");
  const platform = await openLocalMailSink(stage, mailboxId);
  try {
    const sink = platform.sink;
    phase = "iCloud connection";
    await using client = new ImapFlow({
      host: "imap.mail.me.com",
      port: 993,
      secure: true,
      auth: {
        user: credentials.user,
        pass: Redacted.value(credentials.password),
      },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 30_000,
      socketTimeout: 60_000,
    });
    client.on("error", () => {});
    console.error("Connecting to iCloud for a read-only sample…");
    await client.connect();
    phase = "sample selection";
    let plan: SamplePlan;
    if (await Bun.file(planPath).exists())
      plan = Schema.decodeUnknownSync(SamplePlan)(
        await Bun.file(planPath).json(),
      );
    else {
      console.error("Selecting recent messages and related threads…");
      plan = {
        version: 1,
        account,
        stage,
        resources,
        createdAt: new Date().toISOString(),
        ...(await planSample(client, account)),
      };
      await writeFile(planPath, JSON.stringify(plan, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
    }
    if (
      plan.account !== account ||
      plan.stage !== stage ||
      JSON.stringify(plan.resources) !== JSON.stringify(resources) ||
      plan.messages.reduce((sum, message) => sum + message.size, 0) >
        sampleLimits.bytes ||
      plan.messages.some(
        ({ metadata, size }) =>
          size > sampleLimits.messageBytes ||
          metadata.source.account !== account ||
          !sampleFolders.some(
            (folder) =>
              folder.path === metadata.source.mailbox &&
              folder.folder === metadata.folder &&
              folder.archived === metadata.archived,
          ),
      )
    )
      throw new MailSampleError(
        "Saved sample plan does not match this account, local stage, or sample limits.",
      );
    console.error(
      `Sample: ${plan.messages.length} messages; ${(plan.messages.reduce((sum, message) => sum + message.size, 0) / 1024 / 1024).toFixed(1)} MiB.`,
    );
    phase = "sample transfer";
    const result = await runSample(client, sink, plan, (count, total) =>
      console.error(`Checked ${count}/${total} messages.`),
    );
    const report = {
      stage,
      completedAt: new Date().toISOString(),
      ...result,
      imported: result.results.filter(
        (message) => message.status === "imported",
      ).length,
      skipped: result.results.filter((message) => message.status === "skipped")
        .length,
      excludedThreads: plan.excludedThreads,
      totals: await sink.totals(),
    };
    await writeFile(
      join(directory, "report.json"),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
    console.log(JSON.stringify(report, null, 2));
    if (!report.complete) process.exitCode = 1;
  } finally {
    await platform.dispose();
  }
} catch (error) {
  // Never echo server errors or credentials. Local errors use only our fixed
  // stage diagnostics; detailed import failures remain retryable in D1.
  console.error(
    `Mail sample failed during ${phase}. ${error instanceof MailSampleError ? error.message : inventoryErrorMessage(error)}`,
  );
  process.exitCode = 1;
}
