import { Schema as AuthSchema } from "@yielded/auth";
import { ProofReference } from "@yielded/auth/Proofs";
import { Schema } from "effect";
import { accountPath } from "./account-contract.ts";

export const forgotPasswordPage = "/forgot-password";
export const resetPasswordPage = "/reset-password";
export const passwordResetPath = `${accountPath}/password-reset`;

export const RequestPasswordReset = Schema.Struct({
  email: Schema.String.check(Schema.isMaxLength(320)).pipe(
    Schema.decodeTo(AuthSchema.Email),
  ),
});

export const CompletePasswordReset = Schema.Struct({
  reference: ProofReference,
  secret: Schema.RedactedFromValue(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  ),
  newPassword: Schema.RedactedFromValue(
    Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  ),
});
