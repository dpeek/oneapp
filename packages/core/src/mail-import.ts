import { Schema } from "effect";
import { MailSource, Sha256 } from "./mail-snapshot.ts";

export const mailImportScope = "mail:import";
export const mailImportPath = "/api/mail-import";
export const mailImportMaxBytes = 25 * 1024 * 1024;
export const mailImportPlanMaxBytes = 1024 * 1024;
export const MailboxId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/u),
);
export const MailImportMetadata = Schema.Struct({
  source: MailSource,
  folder: Schema.Literals(["inbox", "sent"]),
  archived: Schema.Boolean,
  timestamp: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: 9_999_999_999_999 }),
  ),
  flags: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(
    Schema.isMaxLength(100),
  ),
});
export type MailImportMetadata = typeof MailImportMetadata.Type;
export const MailImportEntry = Schema.Struct({
  sourceId: Sha256,
  sha256: Sha256,
  size: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: mailImportMaxBytes }),
  ),
  metadata: MailImportMetadata,
});
export const MailImportPlan = Schema.Struct({
  version: Schema.Literal(1),
  snapshotId: Schema.String.check(Schema.isUUID(4)),
  inventorySha256: Sha256,
  manifestSha256: Sha256,
  mappingHash: Sha256,
  asOf: Schema.String,
  sourceAccount: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
  entries: Schema.Array(MailImportEntry).check(Schema.isMaxLength(5000)),
});
export type MailImportPlan = typeof MailImportPlan.Type;
export const MailImportReceipt = Schema.NullOr(
  Schema.Struct({
    id: Schema.String,
    sha256: Sha256,
    metadata: Schema.String,
    completedAt: Schema.NullOr(Schema.Int),
  }),
);
export const MailImportResult = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["imported", "skipped"]),
});
export const MailImportDestination = Schema.Struct({
  version: Schema.Literal(1),
  origin: Schema.String,
  mailboxId: MailboxId,
  ownerAccountId: Schema.String,
  name: Schema.String,
  maxMessageBytes: Schema.Int,
  maxPlanBytes: Schema.Int,
});
export const MailImportCompletion = Schema.Struct({
  policy: Schema.Struct({
    version: Schema.Literal(1),
    inactiveDays: Schema.Literal(30),
    asOf: Schema.String,
    cutoff: Schema.Int,
  }),
  completedAt: Schema.Int,
  completedConversations: Schema.Int,
  keptInInbox: Schema.Int,
  alreadyComplete: Schema.Int,
});
