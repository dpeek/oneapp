import { Schema } from "effect";

// Personal vaults currently use Bitwarden's authenticated type-2 encrypted strings.
const Encrypted = Schema.String.check(
  Schema.isMaxLength(128 * 1024),
  Schema.isPattern(
    /^2\.[A-Za-z0-9+/]{22}==\|[A-Za-z0-9+/]{22,}={0,2}\|[A-Za-z0-9+/]{43}=$/u,
  ),
);

const optionalEncrypted = Schema.optionalKey(Schema.NullOr(Encrypted));
const optionalDate = Schema.optionalKey(
  Schema.NullOr(
    Schema.String.check(
      Schema.isMaxLength(40),
      Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/u),
    ),
  ),
);

export const LoginCredentials = Schema.Struct({
  username: optionalEncrypted,
  password: optionalEncrypted,
  totp: optionalEncrypted,
  passwordRevisionDate: optionalDate,
  autofillOnPageLoad: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  uris: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          uri: Schema.NullOr(Encrypted),
          match: Schema.optionalKey(
            Schema.NullOr(Schema.Literals([0, 1, 2, 3, 4, 5])),
          ),
          uriChecksum: optionalEncrypted,
        }),
      ).check(Schema.isMaxLength(100)),
    ),
  ),
});

export const LoginMetadata = {
  notes: optionalEncrypted,
  favorite: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  reprompt: Schema.optionalKey(Schema.NullOr(Schema.Literals([0, 1]))),
  fields: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          type: Schema.Literals([0, 1, 2, 3]),
          name: optionalEncrypted,
          value: optionalEncrypted,
          linkedId: Schema.optionalKey(
            Schema.NullOr(Schema.Number.check(Schema.isInt())),
          ),
        }),
      ).check(Schema.isMaxLength(100)),
    ),
  ),
  passwordHistory: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          lastUsedDate: optionalDate,
          password: optionalEncrypted,
        }),
      ).check(Schema.isMaxLength(100)),
    ),
  ),
};

const LoginDetails = Schema.Struct({
  ...LoginMetadata,
  credentials: LoginCredentials,
});
export type LoginDetails = typeof LoginDetails.Type;
export const LoginName = Encrypted;
export const WrappedItemKey = Schema.String.check(
  Schema.isPattern(
    /^2\.[A-Za-z0-9+/]{22}==\|[A-Za-z0-9+/]{107}=\|[A-Za-z0-9+/]{43}=$/u,
  ),
);
