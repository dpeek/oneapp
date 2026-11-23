import { Schema } from "effect";

const Uid = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 4_294_967_295 }),
);
const Name = Schema.NonEmptyString.check(Schema.isMaxLength(1024));
export const MailSource = Schema.Struct({
  account: Name,
  mailbox: Name,
  uidValidity: Uid,
  uid: Uid,
});
export const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const SnapshotMessage = Schema.Struct({
  id: Sha256,
  source: MailSource,
  internalDate: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: 9_999_999_999_999 }),
  ),
  flags: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(
    Schema.isMaxLength(100),
  ),
  size: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type SnapshotMessage = typeof SnapshotMessage.Type;
export const SnapshotInventory = Schema.Struct({
  format: Schema.Literal("oneapp-mail-snapshot"),
  version: Schema.Literal(1),
  snapshotId: Schema.String.check(Schema.isUUID(4)),
  createdAt: Schema.String,
  source: Schema.Struct({
    protocol: Schema.Literal("imap"),
    host: Name,
    account: Name,
  }),
  folders: Schema.Array(
    Schema.Struct({
      path: Name,
      uidValidity: Uid,
      uidNext: Uid,
      messages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
  messages: Schema.Array(SnapshotMessage),
});
export type SnapshotInventory = typeof SnapshotInventory.Type;
export const SnapshotFile = Schema.Struct({
  id: Sha256,
  sha256: Sha256,
  size: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type SnapshotFile = typeof SnapshotFile.Type;
export const SnapshotManifest = Schema.Struct({
  format: Schema.Literal("oneapp-mail-snapshot"),
  version: Schema.Literal(1),
  snapshotId: SnapshotInventory.fields.snapshotId,
  inventorySha256: Sha256,
  completedAt: Schema.String,
  files: Schema.Array(SnapshotFile),
});
export type SnapshotManifest = typeof SnapshotManifest.Type;
export const MailMapping = Schema.Struct({
  format: Schema.Literal("oneapp-mail-mapping"),
  version: Schema.Literal(1),
  folders: Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.Struct({
        folder: Schema.Literals(["inbox", "sent"]),
        archived: Schema.Boolean,
      }),
      Schema.Struct({ skip: Schema.Literal(true) }),
    ]),
  ),
});
export type MailMapping = typeof MailMapping.Type;
