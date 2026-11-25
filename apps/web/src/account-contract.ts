import { Operations, Schema as AuthSchema } from "@yielded/auth";
import { ProofReference } from "@yielded/auth/Proofs";
import { Schema } from "effect";

export const accountPath = "/api/account";
export const emailVerificationPath = `${accountPath}/email-verification`;
export const passwordChangePath = `${accountPath}/password`;
export const emailChangePath = `${accountPath}/email`;
export const themePreferencePath = `${accountPath}/theme`;

export const ThemePreference = Schema.Literals(["system", "light", "dark"]);
export type ThemePreference = typeof ThemePreference.Type;
export const ChangeTheme = Schema.Struct({ theme: ThemePreference });

export const EmailVerification = Schema.Struct({
  flowId: Operations.RequestBindingFlowId,
  reference: ProofReference,
});

const EmailCode = Schema.RedactedFromValue(
  Schema.String.check(Schema.isPattern(/^\d{6}$/)),
);
const CurrentPassword = Schema.RedactedFromValue(
  Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
);

export const VerifyEmail = Schema.Struct({
  ...EmailVerification.fields,
  code: EmailCode,
});

export const StartEmailChange = Schema.Struct({
  email: Schema.String.check(Schema.isMaxLength(254)).pipe(
    Schema.decodeTo(AuthSchema.Email),
  ),
  currentPassword: CurrentPassword,
});

export const PendingEmailChange = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  email: AuthSchema.Email,
});

export const ConfirmEmailChange = Schema.Struct({
  id: PendingEmailChange.fields.id,
  code: EmailCode,
});

export const ChangedEmail = Schema.Struct({
  oldAddressNotified: Schema.Boolean,
});

export const ChangePassword = Schema.Struct({
  currentPassword: CurrentPassword,
  newPassword: Schema.RedactedFromValue(
    Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  ),
});
