import { Password } from "@yielded/auth";
import { Effect, Layer, Redacted } from "effect";

export const newPasswordRejectionMessage = (
  reason: Password.NewPasswordRejected["reason"],
) =>
  reason === "too-short"
    ? "Use at least 15 characters for your new password"
    : reason === "too-long" || reason === "ill-formed"
      ? "This password is too long or contains unsupported characters"
      : "Choose a password that isn't common, compromised, or based on your account";

export const BootstrapPasswordPolicy = Layer.succeed(
  Password.CompromisedPasswords,
  {
    check: (password) =>
      Effect.succeed(
        /^[A-Za-z0-9_-]{43}$/.test(Redacted.value(password))
          ? { _tag: "Allowed" }
          : { _tag: "Rejected", reason: "common" },
      ),
  },
);

export const AccountPasswordPolicy = Layer.succeed(
  Password.CompromisedPasswords,
  {
    check: (password, { accountName }) =>
      Effect.tryPromise({
        try: async (signal) => {
          const value = Redacted.value(password);
          if (value.toLowerCase() === accountName?.toLowerCase()) {
            return { _tag: "Rejected", reason: "contextual" } as const;
          }

          // Pwned Passwords receives only the first five hex characters. Match
          // the rest of the digest locally against a padded response.
          const bytes = await crypto.subtle.digest(
            "SHA-1",
            new TextEncoder().encode(value),
          );
          const hash = new Uint8Array(bytes).toHex().toUpperCase();
          const response = await fetch(
            `https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`,
            { headers: { "Add-Padding": "true" }, redirect: "error", signal },
          );
          if (!response.ok) throw new Error("Password screening unavailable");
          const prefix = hash.slice(5) + ":";
          const compromised = (await response.text())
            .split(/\r?\n/)
            .some(
              (line) => line.startsWith(prefix) && Number(line.slice(36)) > 0,
            );
          return compromised
            ? ({ _tag: "Rejected", reason: "compromised" } as const)
            : ({ _tag: "Allowed" } as const);
        },
        catch: () => Password.PasswordCheckUnavailable.make({}),
      }).pipe(Effect.withTracerEnabled(false)),
  },
);
