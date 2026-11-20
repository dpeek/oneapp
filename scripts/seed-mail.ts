import {
  D1,
  DurableObjectNamespace,
  R2Bucket,
} from "@alchemy.run/cloudflare-runtime/core/bindings";
import { getPlatformProxy } from "@alchemy.run/cloudflare-runtime/core/platform-proxy";
import { join } from "node:path";
import { parseArgs } from "node:util";

const {
  values: { stage },
} = parseArgs({
  args: process.argv.slice(2),
  options: { stage: { type: "string", default: "dev_ui" } },
});
if (!/^[a-zA-Z0-9_-]+$/u.test(stage))
  throw new Error("Invalid local stage name.");

const directory = join(import.meta.dir, "..", ".alchemy");
const localResource = async (
  name: string,
  field: "bucketName" | "databaseId",
) => {
  const file = Bun.file(
    join(directory, "state", "OneApp", stage, `${name}.json`),
  );
  if (!(await file.exists()))
    throw new Error(`Start alchemy dev for stage ${stage} first.`);
  const state: { providerMode?: unknown; attr?: Record<string, unknown> } =
    await file.json();
  const id = state.attr?.[field];
  if (
    state.providerMode !== "local" ||
    typeof id !== "string" ||
    !id.startsWith("dev:")
  )
    throw new Error(`Stage ${stage} does not have a local ${name} resource.`);
  return id;
};

const [inbox, sent, database] = await Promise.all([
  localResource("InboxMessages", "bucketName"),
  localResource("SentMessages", "bucketName"),
  localResource("Database", "databaseId"),
]);
const { outputs } = await Bun.build({
  entrypoints: [join(import.meta.dir, "seed-mail-worker.ts")],
  target: "browser",
  external: ["cloudflare:*", "node:*"],
  minify: true,
});
const [bundle] = outputs;
if (!bundle) throw new Error("Could not build the local mail fixture worker.");

// Run in workerd so the mail index can use native D1 prepared-statement batches.
const platform = await getPlatformProxy<{
  SEED_MAIL: { getByName(name: string): { run(): Promise<number> } };
}>({
  name: "oneapp-mail-fixtures",
  compatibilityDate: "2026-11-01",
  persist: { directory: join(directory, "local") },
  bindings: [
    R2Bucket.local({ binding: "INBOX_MESSAGES", id: inbox }),
    R2Bucket.local({ binding: "SENT_MESSAGES", id: sent }),
    D1.local({ binding: "DB", id: database }),
    DurableObjectNamespace.local({
      binding: "SEED_MAIL",
      className: "SeedMail",
    }),
  ],
  modules: [
    { name: "seed-mail.mjs", type: "ESModule", content: await bundle.text() },
  ],
  durableObjectNamespaces: [{ className: "SeedMail", sql: false }],
});
try {
  const added = await platform.env.SEED_MAIL.getByName(stage).run();
  console.log(`Added ${added} sample messages to ${stage}.`);
} finally {
  await platform.dispose();
}
