import { Schema } from "effect";
import {
  EncryptedVaultValue,
  WrappedItemKey,
} from "../../vault-items-contract.ts";
import {
  ItemMetadata,
  LoginCredentials,
  LoginPasswordHistory,
} from "../vault/item.ts";

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

const common = {
  name: EncryptedVaultValue,
  key: WrappedItemKey,
  ...ItemMetadata,
  encryptedFor: optionalId,
  encryptedByKeyId: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u))),
  ),
  organizationId: empty,
  folderId: empty,
  archivedDate: empty,
  lastKnownRevisionDate: Schema.optionalKey(Schema.NullOr(Schema.String)),
  data: empty,
  card: empty,
  identity: empty,
  sshKey: empty,
  bankAccount: empty,
  driversLicense: empty,
  passport: empty,
  attachments: emptyObject,
  attachments2: emptyObject,
};

const LoginRequest = Schema.Struct({
  ...common,
  type: Schema.Literal(1),
  login: Schema.Struct({
    ...LoginCredentials.fields,
    fido2Credentials: emptyArray,
  }),
  secureNote: empty,
  passwordHistory: LoginPasswordHistory,
});

const SecureNoteRequest = Schema.Struct({
  ...common,
  type: Schema.Literal(2),
  login: empty,
  secureNote: Schema.Struct({ type: Schema.Literal(0) }),
  passwordHistory: emptyArray,
});

const decode = Schema.decodeUnknownSync(
  Schema.Union([LoginRequest, SecureNoteRequest]),
);

export const decodeItem = (body: string) => {
  try {
    const item = decode(JSON.parse(body));
    const {
      name,
      key,
      encryptedFor,
      encryptedByKeyId,
      lastKnownRevisionDate,
      notes,
      favorite,
      reprompt,
      fields,
    } = item;
    const envelope = {
      name,
      wrappedKey: key,
      encryptedFor,
      encryptedByKeyId,
      lastKnownRevisionDate,
    };
    const metadata = { notes, favorite, reprompt, fields };
    if (item.type === 2)
      return { ...envelope, type: item.type, details: metadata };
    const { fido2Credentials: _, ...credentials } = item.login;
    return {
      ...envelope,
      type: item.type,
      details: {
        credentials,
        ...metadata,
        passwordHistory: item.passwordHistory,
      },
    };
  } catch {
    return null;
  }
};
