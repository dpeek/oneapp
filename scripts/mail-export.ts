import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { Redacted } from "effect";
import { ImapFlow } from "imapflow";
import { inventoryCredentials } from "./mail/config.ts";
import { inventoryErrorMessage, MailSampleError } from "./mail/errors.ts";
import { atomicJson, withFileLock } from "./mail/files.ts";
import {
  exportSnapshot,
  inventorySnapshot,
  readInventory,
  validateSnapshot,
} from "./mail/snapshot.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    out: { type: "string", default: ".mail-snapshots/icloud" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "bun run mail:export [--out .mail-snapshots/icloud]\nExports Inbox, Sent Messages and Archive read-only. Resumes the frozen inventory; completed snapshots are verified offline.",
  );
  process.exit(0);
}
try {
  const directory = resolve(values.out);
  await withFileLock(join(directory, ".export.lock"), async () => {
    if (await Bun.file(join(directory, "manifest.json")).exists()) {
      const { inventory } = await validateSnapshot(directory);
      console.log(
        JSON.stringify({
          complete: true,
          verified: inventory.messages.length,
          directory,
        }),
      );
      return;
    }
    const credentials = inventoryCredentials(undefined, process.env);
    if (!credentials.user || !credentials.password)
      throw new MailSampleError(
        "Set ICLOUD_IMAP_USER and ICLOUD_IMAP_PASSWORD in .env.",
      );
    const account = `icloud:${credentials.user.toLowerCase()}`;
    const auth = {
      user: credentials.user,
      pass: Redacted.value(credentials.password),
    };
    const createClient = () =>
      new ImapFlow({
        host: "imap.mail.me.com",
        port: 993,
        secure: true,
        auth,
        logger: false,
        disableAutoIdle: true,
        connectionTimeout: 30_000,
        socketTimeout: 60_000,
      });
    await using client = createClient();
    client.on("error", () => {});
    await client.connect();
    if (!(await Bun.file(join(directory, "inventory.json")).exists())) {
      console.error("Capturing source folder metadata…");
      await atomicJson(
        join(directory, "inventory.json"),
        await inventorySnapshot(client, account, [
          "INBOX",
          "Sent Messages",
          "Archive",
        ]),
      );
    }
    const { inventory } = await readInventory(directory);
    if (
      inventory.source.account !== account ||
      inventory.source.host !== "imap.mail.me.com"
    )
      throw new MailSampleError(
        "Snapshot belongs to a different source account.",
      );
    console.error(
      `Exporting ${inventory.messages.length} messages to ${directory}…`,
    );
    await using second = createClient();
    await using third = createClient();
    for (const connection of [second, third]) {
      connection.on("error", () => {});
      await connection.connect();
    }
    const report = await exportSnapshot(
      directory,
      client,
      (done, total) => {
        if (done % 25 === 0 || done === total)
          console.error(`Exported/checked ${done}/${total}.`);
      },
      [second, third],
    );
    console.log(JSON.stringify({ directory, ...report }, null, 2));
    if (!report.complete) process.exitCode = 1;
  });
} catch (error) {
  console.error(
    error instanceof MailSampleError
      ? error.message
      : inventoryErrorMessage(error),
  );
  process.exitCode = 1;
}
