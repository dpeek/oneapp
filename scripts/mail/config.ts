import { Redacted } from "effect";

export const inventoryCredentials = (
  user: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
) => ({
  user: (user ?? env.ICLOUD_IMAP_USER)?.trim() || undefined,
  password: env.ICLOUD_IMAP_PASSWORD?.trim()
    ? Redacted.make(env.ICLOUD_IMAP_PASSWORD.trim())
    : undefined,
});
