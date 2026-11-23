import type { MailSample } from "../mail-sample-worker.ts";
import {
  D1,
  DurableObjectNamespace,
  R2Bucket,
} from "@alchemy.run/cloudflare-runtime/core/bindings";
import { getPlatformProxy } from "@alchemy.run/cloudflare-runtime/core/platform-proxy";
import { join } from "node:path";
import { localDirectory, localMailResources } from "./local.ts";
import { MailSampleError } from "./errors.ts";
import type { SnapshotSink } from "./replay.ts";
import type { CompletionRequest } from "../../apps/web/src/server/mail-import-completion.ts";

export const openLocalMailSink = async (stage: string, mailboxId: string) => {
  const resources = await localMailResources(stage);
  const { outputs } = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "mail-sample-worker.ts")],
    target: "browser",
    external: ["cloudflare:*", "node:*"],
    minify: true,
  });
  const bundle = outputs[0];
  if (!bundle)
    throw new MailSampleError("Could not bundle the local import worker.");
  const platform = await getPlatformProxy<{
    MAIL_IMPORT: {
      getByName(name: string): MailSample;
    };
  }>({
    name: "oneapp-snapshot-import",
    compatibilityDate: "2026-11-01",
    persist: { directory: join(localDirectory, "local") },
    bindings: [
      R2Bucket.local({ binding: "INBOX_MESSAGES", id: resources.inbox }),
      R2Bucket.local({ binding: "SENT_MESSAGES", id: resources.sent }),
      D1.local({ binding: "DB", id: resources.database }),
      DurableObjectNamespace.local({
        binding: "MAIL_IMPORT",
        className: "MailSample",
      }),
    ],
    modules: [
      {
        name: "mail-import.mjs",
        type: "ESModule",
        content: await bundle.text(),
      },
    ],
    durableObjectNamespaces: [{ className: "MailSample", sql: false }],
  });
  try {
    const remote = platform.env.MAIL_IMPORT.getByName(`${stage}:${mailboxId}`);
    const sink = {
      ready: () => remote.ready(mailboxId),
      receipt: (source: Parameters<SnapshotSink["receipt"]>[0]) =>
        remote.receipt(mailboxId, source),
      completed: (source: Parameters<SnapshotSink["receipt"]>[0]) =>
        remote.completed(mailboxId, source),
      ingest: (
        metadata: Parameters<SnapshotSink["ingest"]>[0],
        raw: Uint8Array<ArrayBuffer>,
      ) => remote.ingest(mailboxId, metadata, raw),
      completeImport: (request: CompletionRequest) =>
        remote.completeImport(mailboxId, request),
      totals: () => remote.totals(mailboxId),
    };
    await sink.ready();
    return { sink, resources, dispose: platform.dispose };
  } catch {
    await platform.dispose();
    throw new MailSampleError(
      "The local import schema is unavailable. Start mail:dev for this stage first.",
    );
  }
};
