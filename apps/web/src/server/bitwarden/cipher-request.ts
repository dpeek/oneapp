import { Schema } from "effect";
import {
  LoginCredentials,
  LoginMetadata,
  LoginName,
  WrappedItemKey,
} from "../vault/login.ts";

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

const LoginRequest = Schema.Struct({
  type: Schema.Literal(1),
  name: LoginName,
  key: WrappedItemKey,
  ...LoginMetadata,
  login: Schema.Struct({
    ...LoginCredentials.fields,
    fido2Credentials: emptyArray,
  }),
  encryptedFor: optionalId,
  encryptedByKeyId: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u))),
  ),
  organizationId: empty,
  folderId: empty,
  archivedDate: empty,
  lastKnownRevisionDate: Schema.optionalKey(Schema.NullOr(Schema.String)),
  data: empty,
  secureNote: empty,
  card: empty,
  identity: empty,
  sshKey: empty,
  bankAccount: empty,
  driversLicense: empty,
  passport: empty,
  attachments: emptyObject,
  attachments2: emptyObject,
});

const decode = Schema.decodeUnknownSync(LoginRequest);

export const decodeLogin = (body: string) => {
  try {
    const {
      name,
      key,
      login: { fido2Credentials: _, ...credentials },
      encryptedFor,
      encryptedByKeyId,
      lastKnownRevisionDate,
      notes,
      favorite,
      reprompt,
      fields,
      passwordHistory,
    } = decode(JSON.parse(body));
    return {
      name,
      wrappedKey: key,
      encryptedFor,
      encryptedByKeyId,
      lastKnownRevisionDate,
      details: {
        credentials,
        notes,
        favorite,
        reprompt,
        fields,
        passwordHistory,
      },
    };
  } catch {
    return null;
  }
};
