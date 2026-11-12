import { Schema } from "effect";

export const cliTokensPath = "/api/cli-tokens";
export const currentCliTokenPath = `${cliTokensPath}/current`;
export const cliLoginPath = "/api/cli-login";
export const cliLoginQuery = "connect-cli";

export const CliTokenSecret = Schema.String.check(
  Schema.isPattern(/^one_[A-Za-z0-9_-]{43}$/u),
);
export const CliTokenLabel = Schema.Trimmed.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(60),
);
export const CreateCliToken = Schema.Struct({
  label: Schema.Trim.pipe(Schema.decodeTo(CliTokenLabel)),
});
export const CliToken = Schema.Struct({
  id: Schema.String,
  label: CliTokenLabel,
  createdAt: Schema.Int,
  expiresAt: Schema.NullOr(Schema.Int),
});
export const CliTokenList = Schema.Array(CliToken);
export const IssuedCliToken = Schema.Struct({
  token: CliToken,
  secret: CliTokenSecret,
});

export const CliLoginId = Schema.String.check(Schema.isUUID(4));
export const CliLoginApproval = Schema.Struct({
  id: CliLoginId,
  code: Schema.String.check(Schema.isPattern(/^[A-F0-9]{4}-[A-F0-9]{4}$/u)),
  label: CliTokenLabel,
  expiresAt: Schema.Int,
});
export const CliLoginDecision = Schema.Struct({ approve: Schema.Boolean });
export const cliLoginInterval = 5_000;
