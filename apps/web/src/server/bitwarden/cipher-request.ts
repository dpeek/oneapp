import { AttachmentId } from "../../vault-attachment-contract.ts";
import { Schema } from "effect";
import {
  EncryptedVaultValue,
  ExtraItemType,
  extraItemTypes,
  encryptedTypeData,
  itemContent,
  ItemMetadata,
  ItemType,
  optionalDate,
  itemTypes,
  LoginCredentials,
  LoginPasswordHistory,
  WrappedItemKey,
} from "../../vault-item-content.ts";

const optionalId = Schema.optionalKey(
  Schema.NullOr(Schema.String.check(Schema.isUUID())),
);
const empty = Schema.optionalKey(Schema.Null);
const emptyArray = Schema.optionalKey(
  Schema.NullOr(Schema.Array(Schema.Never)),
);

const envelope = Schema.Struct({
  name: EncryptedVaultValue,
  key: WrappedItemKey,
  encryptedFor: optionalId,
  encryptedByKeyId: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u))),
  ),
  organizationId: empty,
  folderId: optionalId,
  archivedDate: optionalDate,
  lastKnownRevisionDate: Schema.optionalKey(Schema.NullOr(Schema.String)),
  data: empty,
  attachments: Schema.optionalKey(
    Schema.NullOr(
      Schema.Record(AttachmentId, Schema.NullOr(EncryptedVaultValue)),
    ),
  ),
  attachments2: Schema.optionalKey(
    Schema.NullOr(
      Schema.Record(
        AttachmentId,
        Schema.Struct({
          fileName: EncryptedVaultValue,
          key: WrappedItemKey,
          lastKnownRevisionDate: optionalDate,
        }),
      ),
    ),
  ),
});

const metadata = Schema.Struct(ItemMetadata);
const login = Schema.Struct({
  ...LoginCredentials.fields,
  fido2Credentials: emptyArray,
});
const note = Schema.Struct({ type: Schema.Literal(0) });
const nonLoginHistory = Schema.Struct({ passwordHistory: emptyArray });
const loginHistory = Schema.Struct({ passwordHistory: LoginPasswordHistory });
const typeDecoders = new Map(
  extraItemTypes.map((type) => [
    type,
    Schema.decodeUnknownSync(
      Schema.Struct({ ...encryptedTypeData(type).fields, response: empty }),
    ),
  ]),
);
const isType = Schema.is(ItemType);
const isAttachmentId = Schema.is(AttachmentId);
const isExtraType = Schema.is(ExtraItemType);

export const decodeCipher = (input: unknown, allowPartial = false) => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input))
      return null;
    const cipher = input as Record<string, unknown>;
    const { type } = cipher;
    if (!isType(type)) return null;
    const payloadKey = itemTypes[type].wire;
    if (
      Object.values(itemTypes).some(
        ({ wire }) => wire !== payloadKey && cipher[wire] != null,
      )
    )
      return null;

    const {
      name,
      key,
      encryptedFor,
      encryptedByKeyId,
      lastKnownRevisionDate,
      folderId,
      archivedDate,
      attachments2,
    } = Schema.decodeUnknownSync(envelope)(cipher);
    const properties = Schema.decodeUnknownSync(metadata)(cipher);
    const payload = cipher[payloadKey];
    if (type === 1) {
      if (payload != null) {
        const { fido2Credentials: _, ...credentials } =
          Schema.decodeUnknownSync(login)(payload);
        Object.assign(properties, { credentials });
      }
      Object.assign(properties, Schema.decodeUnknownSync(loginHistory)(cipher));
    } else {
      Schema.decodeUnknownSync(nonLoginHistory)(cipher);
      if (payload != null && type === 2)
        Schema.decodeUnknownSync(note)(payload);
      if (payload != null && isExtraType(type)) {
        const decode = typeDecoders.get(type)!;
        // Stock type requests serialize the inherited BaseResponse slot as null.
        const { response: _, ...data } = decode(payload, {
          onExcessProperty: "error",
        });
        Object.assign(properties, { data });
      }
    }
    if (payload == null && (!allowPartial || lastKnownRevisionDate == null))
      return null;
    const attachmentIds = [
      ...new Set([
        ...Object.keys((cipher.attachments as object | null | undefined) ?? {}),
        ...Object.keys(
          (cipher.attachments2 as object | null | undefined) ?? {},
        ),
      ]),
    ];
    if (!attachmentIds.every(isAttachmentId)) return null;
    return {
      name,
      wrappedKey: key,
      attachmentIds,
      attachmentUpdates: Object.entries(attachments2 ?? {}).map(
        ([id, record]) => ({
          id,
          name: record.fileName,
          wrappedKey: record.key,
        }),
      ),
      folderId,
      archivedDate,
      encryptedFor,
      encryptedByKeyId,
      lastKnownRevisionDate,
      ...itemContent(type, properties),
    };
  } catch {
    return null;
  }
};

export const decodeItem = (body: string, allowPartial: boolean) => {
  try {
    return decodeCipher(JSON.parse(body), allowPartial);
  } catch {
    return null;
  }
};
