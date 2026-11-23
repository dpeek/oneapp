import { openRemoteMailSink, planRemoteImport } from "./mail/remote-sink.ts";
import { serverOrigin } from "../apps/cli/src/credentials.ts";
import { MailboxId } from "../packages/core/src/mail-import.ts";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { Schema } from "effect";
import { MailMapping } from "../packages/core/src/mail-snapshot.ts";
import { atomicJson, withFileLock, hashFile, sha256 } from "./mail/files.ts";
import { validateSnapshot } from "./mail/snapshot.ts";
import { mappingHash, previewMapping, replaySnapshot } from "./mail/replay.ts";
import { openLocalMailSink } from "./mail/local-sink.ts";
import { localDirectory, StageName } from "./mail/local.ts";
import { MailSampleError } from "./mail/errors.ts";
import { importCompletionPolicy } from "../apps/web/src/server/mail-import-completion.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    snapshot: { type: "string", default: ".mail-snapshots/icloud" },
    stage: { type: "string" },
    server: { type: "string" },
    mailbox: { type: "string" },
    mapping: {
      type: "string",
      default: join(import.meta.dir, "mail", "icloud-mapping.json"),
    },
    "dry-run": { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "bun run mail:import --snapshot <directory> (--stage <local-stage> | --server <https-origin>) --mailbox <mailbox-id> [--mapping <json>] [--dry-run]\nValidates all original checksums before importing. Dry-run previews mappings without connecting to iCloud or opening a destination.",
  );
  process.exit(0);
}
try {
  if (values.stage && values.server)
    throw new MailSampleError(
      "Choose either a local --stage or a remote --server, not both.",
    );
  const origin = values.server ? serverOrigin(values.server) : undefined;
  if (!values["dry-run"] && ((!values.stage && !origin) || !values.mailbox))
    throw new MailSampleError(
      "Choose --stage or --server and an explicit --mailbox, or use --dry-run.",
    );
  const directory = resolve(values.snapshot);
  console.error("Validating snapshot metadata and every original checksum…");
  const { inventory, manifest } = await validateSnapshot(directory);
  const mapping = Schema.decodeUnknownSync(MailMapping)(
    await Bun.file(values.mapping).json(),
  );
  const preview = previewMapping(inventory, mapping);
  const remotePlan = origin
    ? planRemoteImport(
        inventory,
        manifest,
        mapping,
        (await hashFile(join(directory, "manifest.json"))).sha256,
      )
    : undefined;
  console.log(
    JSON.stringify(
      {
        ...(origin ? { server: origin, mailboxId: values.mailbox } : {}),
        snapshotId: inventory.snapshotId,
        messages: inventory.messages.length,
        folders: preview,
        completionPolicy: importCompletionPolicy(inventory.createdAt),
      },
      null,
      2,
    ),
  );
  if (!values["dry-run"]) {
    const stage = origin
      ? undefined
      : Schema.decodeUnknownSync(StageName)(values.stage);

    const mailboxId = Schema.decodeUnknownSync(MailboxId)(values.mailbox);
    const stateDirectory = join(
      localDirectory,
      "mail-import",
      origin ? `remote-${sha256(origin)}` : stage!,
      mailboxId,
    );
    await withFileLock(join(stateDirectory, ".import.lock"), async () => {
      const platform =
        origin && remotePlan
          ? await openRemoteMailSink(
              origin,
              mailboxId,
              remotePlan,
              process.env.ONEAPP_IMPORT_TOKEN,
            )
          : await openLocalMailSink(stage!, mailboxId);
      try {
        const config = {
          version: 2,
          mailboxId,
          account: inventory.source.account,
          mappingHash: mappingHash(mapping),
          resources: platform.resources,
        };
        const configPath = join(stateDirectory, "snapshot-import-config.json");
        if (await Bun.file(configPath).exists()) {
          if (
            JSON.stringify(await Bun.file(configPath).json()) !==
            JSON.stringify(config)
          )
            throw new MailSampleError(
              "This destination was used with different mappings or source configuration. Use a fresh destination mailbox.",
            );
        } else await atomicJson(configPath, config);
        if ("begin" in platform) await platform.begin();
        const report = await replaySnapshot(
          directory,
          inventory,
          manifest,
          mapping,
          platform.sink,
          (done, total) => {
            if (done % 25 === 0 || done === total)
              console.error(`Imported/checked ${done}/${total}.`);
          },
        );
        const completion = report.complete
          ? "begin" in platform
            ? await platform.sink.completeImport()
            : await platform.sink.completeImport({
                id: `${inventory.snapshotId}:${config.mappingHash}`,
                asOf: inventory.createdAt,
                sourceIds: report.results
                  .filter((entry) => entry.status !== "excluded")
                  .map((entry) => entry.sourceId),
              })
          : undefined;
        await atomicJson(
          join(stateDirectory, `${inventory.snapshotId}-report.json`),
          {
            snapshotId: inventory.snapshotId,
            mappingHash: config.mappingHash,
            completedAt: new Date().toISOString(),
            ...report,
            completion,
          },
        );
        const { results: _results, ...summary } = report;
        const completionSummary = completion && {
          policy: completion.policy,
          completedConversations: completion.completedConversations,
          keptInInbox: completion.keptInInbox,
          alreadyComplete: completion.alreadyComplete,
        };
        console.log(
          JSON.stringify(
            {
              ...(origin ? { server: origin } : { stage }),
              mailboxId,
              ...summary,
              completion: completionSummary,
            },
            null,
            2,
          ),
        );
        if (!report.complete) process.exitCode = 1;
      } finally {
        await platform.dispose();
      }
    });
  }
} catch (error) {
  console.error(
    error instanceof MailSampleError
      ? error.message
      : "Snapshot import failed. Check the snapshot, mapping file and destination; no credentials or server errors were printed.",
  );
  process.exitCode = 1;
}
