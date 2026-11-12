import { Schema } from "effect";

export const cliTokensPath = "/api/cli-tokens";
export const currentCliTokenPath = `${cliTokensPath}/current`;

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
  expiresAt: Schema.Int,
});
export const CliTokenList = Schema.Array(CliToken);
export const IssuedCliToken = Schema.Struct({
  token: CliToken,
  secret: CliTokenSecret,
});
