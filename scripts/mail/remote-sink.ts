import { Effect, Redacted, Schema } from "effect";
import { CliTokenSecret } from "../../packages/core/src/cli-auth.ts";
import {
  MailImportDestination,
  MailImportPlan,
  MailImportReceipt,
  MailImportResult,
  MailImportCompletion,
  mailImportPath,
  mailImportPlanMaxBytes,
} from "../../packages/core/src/mail-import.ts";
import type {
  SnapshotInventory,
  SnapshotManifest,
  MailMapping,
} from "../../packages/core/src/mail-snapshot.ts";
import { credentials, serverOrigin } from "../../apps/cli/src/credentials.ts";
import { MailSampleError } from "./errors.ts";
import { sourceId } from "./snapshot.ts";
import { mappingHash, previewMapping, type SnapshotSink } from "./replay.ts";

export const planRemoteImport = (
  inventory: SnapshotInventory,
  manifest: SnapshotManifest,
  mapping: MailMapping,
  manifestSha256: string,
): MailImportPlan => {
  previewMapping(inventory, mapping);
  const files = new Map(manifest.files.map((file) => [file.id, file]));
  const candidate = {
    version: 1,
    snapshotId: inventory.snapshotId,
    inventorySha256: manifest.inventorySha256,
    manifestSha256,
    mappingHash: mappingHash(mapping),
    asOf: inventory.createdAt,
    sourceAccount: inventory.source.account,
    entries: inventory.messages.flatMap((entry) => {
      const target = mapping.folders[entry.source.mailbox]!;
      if ("skip" in target) return [];
      return [
        {
          sourceId: entry.id,
          sha256: files.get(entry.id)?.sha256,
          size: entry.size,
          metadata: {
            source: entry.source,
            folder: target.folder,
            archived: target.archived,
            timestamp: entry.internalDate,
            flags: entry.flags,
          },
        },
      ];
    }),
  };
  const result = Schema.decodeUnknownOption(MailImportPlan)(candidate);
  if (
    result._tag === "None" ||
    new TextEncoder().encode(JSON.stringify(result.value)).length >
      mailImportPlanMaxBytes
  )
    throw new MailSampleError(
      "Snapshot exceeds the production adapter limits: 25 MiB per message, 5,000 selected messages and a 1 MiB import plan. Nothing was uploaded.",
    );
  return result.value;
};

type Transport = { fetch: typeof fetch; sleep: (ms: number) => Promise<void> };
const defaultTransport: Transport = {
  fetch: globalThis.fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const openRemoteMailSink = async (
  server: string,
  mailboxId: string,
  plan: MailImportPlan,
  tokenOverride?: string,
  transport = defaultTransport,
) => {
  const origin = serverOrigin(server);
  let secret = tokenOverride;
  if (!secret) {
    const saved = await Effect.runPromise(credentials).catch(() => {
      throw new MailSampleError(
        "Sign in with oru auth login --mail-import --server <origin> first.",
      );
    });
    if (saved.origin !== origin)
      throw new MailSampleError(
        "Saved CLI credentials belong to another server. Sign in to the explicit import destination first.",
      );
    secret = Redacted.value(saved.token);
  }
  if (!Schema.is(CliTokenSecret)(secret))
    throw new MailSampleError(
      "Invalid import credential. Sign in with oru auth login --mail-import.",
    );
  const base = `${mailImportPath}/${encodeURIComponent(mailboxId)}`;
  const request = async <A>(
    path: string,
    schema: Schema.Decoder<A>,
    init: RequestInit = {},
  ) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      let response: Response;
      try {
        response = await transport.fetch(origin + path, {
          ...init,
          redirect: "error",
          credentials: "omit",
          signal: AbortSignal.timeout(60_000),
          headers: { ...init.headers, authorization: `Bearer ${secret}` },
        });
      } catch {
        if (attempt < 3) {
          await transport.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new MailSampleError(
          "Could not reach the import server. Rerun the same command to resume.",
        );
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await response.body?.cancel();
        await transport.sleep(
          Math.min(
            5000,
            Math.max(
              500 * 2 ** attempt,
              Number(response.headers.get("retry-after") ?? 0) * 1000 || 0,
            ),
          ),
        );
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403)
          throw new MailSampleError(
            "Import access is missing, expired or revoked. Run oru auth login --mail-import for this server, then resume.",
          );
        throw new MailSampleError(
          `Import server returned HTTP ${response.status}. Import stopped; rerun with the same snapshot and mapping after resolving the error.`,
        );
      }
      try {
        return Schema.decodeUnknownSync(schema)(await response.json());
      } catch {
        throw new MailSampleError(
          "Import server returned an invalid response. Import stopped without trusting the result.",
        );
      }
    }
    throw new MailSampleError("Import request failed");
  };
  const destination = await request(base, MailImportDestination);
  if (
    destination.origin !== origin ||
    destination.mailboxId !== mailboxId ||
    destination.maxPlanBytes <
      new TextEncoder().encode(JSON.stringify(plan)).length ||
    plan.entries.some((entry) => entry.size > destination.maxMessageBytes)
  )
    throw new MailSampleError(
      "The server destination or upload limits do not match this import. Nothing was uploaded.",
    );
  const run = `${base}/${plan.snapshotId}`;
  const sink: SnapshotSink & {
    completeImport: () => Promise<typeof MailImportCompletion.Type>;
  } = {
    receipt: (source) =>
      request(`${run}/${sourceId(source)}`, MailImportReceipt),
    ingest: async (metadata, raw) =>
      request(`${run}/${sourceId(metadata.source)}`, MailImportResult, {
        method: "PUT",
        headers: { "content-type": "message/rfc822" },
        body: raw,
      }),
    completeImport: () =>
      request(`${run}/complete`, MailImportCompletion, { method: "POST" }),
  };
  return {
    resources: {
      origin,
      mailboxId,
      ownerAccountId: destination.ownerAccountId,
    },
    begin: () =>
      request(
        run,
        Schema.Struct({ snapshotId: MailImportPlan.fields.snapshotId }),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(plan),
        },
      ),
    sink,
    dispose: async () => {},
  };
};
