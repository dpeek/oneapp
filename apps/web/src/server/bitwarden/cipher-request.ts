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
const emptyObject = Schema.optionalKey(
  Schema.NullOr(Schema.Record(Schema.String, Schema.Never)),
);
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
  attachments: emptyObject,
  attachments2: emptyObject,
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
    Schema.decodeUnknownSync(encryptedTypeData(type)),
  ]),
);
const isType = Schema.is(ItemType);
const isExtraType = Schema.is(ExtraItemType);

export const decodeCipher = (input: unknown) => {
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
        Object.assign(properties, {
          data: decode(payload, { onExcessProperty: "error" }),
        });
      }
    }
    if (payload == null && lastKnownRevisionDate == null) return null;
    return {
      name,
      wrappedKey: key,
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

export const decodeItem = (body: string) => {
  try {
    return decodeCipher(JSON.parse(body));
  } catch {
    return null;
  }
};
