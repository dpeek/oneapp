import { join } from "node:path";
import { Schema } from "effect";
import { MailSampleError } from "./errors.ts";

export const StageName = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/u),
);
export const localDirectory = join(import.meta.dir, "..", "..", ".alchemy");
const LocalState = Schema.Struct({
  providerMode: Schema.Literal("local"),
  attr: Schema.Record(Schema.String, Schema.Unknown),
});

export const localMailResources = async (stage: string) => {
  Schema.decodeUnknownSync(StageName)(stage);
  const read = async (name: string, field: string) => {
    const file = Bun.file(
      join(localDirectory, "state", "OneApp", stage, `${name}.json`),
    );
    if (!(await file.exists()))
      throw new MailSampleError(
        `Start the local stage first with bun run mail:dev --stage ${stage}.`,
      );
    const state = Schema.decodeUnknownOption(LocalState)(await file.json());
    if (state._tag === "None")
      throw new MailSampleError(
        "Mail imports require local D1 and R2 resources.",
      );
    const id = state.value.attr[field];
    if (typeof id !== "string" || !id.startsWith("dev:"))
      throw new MailSampleError(
        "Mail imports require local D1 and R2 resources.",
      );
    return id;
  };
  const [inbox, sent, database] = await Promise.all([
    read("InboxMessages", "bucketName"),
    read("SentMessages", "bucketName"),
    read("Database", "databaseId"),
  ]);
  return { inbox, sent, database };
};
