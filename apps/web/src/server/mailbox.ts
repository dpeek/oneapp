import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { Schema } from "effect";
import { MailMessageId } from "../inbox-contract.ts";
import { ownerId } from "./auth.ts";
import { PersonEmail, normalizePersonEmail } from "../people-contract.ts";

export const defaultMailboxId = "personal";
import { MailboxId } from "@oneapp/core/mail-import";
export { MailboxId } from "@oneapp/core/mail-import";
export type MailDatabase = D1Database & { readonly mailboxId: string };

// Scope is explicit at every mail query; this adapter does not rewrite SQL.
export const mailDatabase = (db: D1Database, id: string): MailDatabase => {
  const mailboxId = Schema.decodeUnknownSync(MailboxId)(id);
  return new Proxy(db, {
    get(target, property) {
      if (property === "mailboxId") return mailboxId;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as MailDatabase;
};

// Only a validated identifier can become a SQL literal. Existing numbered
// query parameters remain stable while the ownership predicate stays visible.
export const mailboxSql = (db: MailDatabase) =>
  `'${Schema.decodeUnknownSync(MailboxId)(db.mailboxId)}'`;

export const requireMailbox = async (
  db: D1Database,
  id: string,
  accountId: string,
) => {
  Schema.decodeUnknownSync(MailboxId)(id);
  const mailbox = await db
    .prepare(
      "SELECT id, owner_account_id AS ownerAccountId, name FROM mailboxes WHERE id = ? AND owner_account_id = ?",
    )
    .bind(id, accountId)
    .first<{ id: string; ownerAccountId: string; name: string }>();
  if (!mailbox) throw new Error("Mailbox is unavailable to this account");
  return mailbox;
};

export const ensureDefaultMailbox = async (
  db: D1Database,
  receivingAddress?: string,
  sendingAddress?: string,
  aliases?: string,
) => {
  await db
    .prepare(
      "INSERT OR IGNORE INTO mailboxes (id, owner_account_id, name) SELECT ?, id, 'Personal' FROM accounts WHERE id = ?",
    )
    .bind(defaultMailboxId, ownerId)
    .run();
  await requireMailbox(db, defaultMailboxId, ownerId);
  const identities = new Set(
    [receivingAddress, sendingAddress, ...(aliases?.split(",") ?? [])]
      .filter((v): v is string => Boolean(v?.trim()))
      .map(normalizePersonEmail),
  );
  for (const address of identities) {
    Schema.decodeUnknownSync(PersonEmail)(address);
    // Bootstrap only: changing a login or redeploying must not overwrite
    // manually managed routing or sending permissions.
    await db
      .prepare(
        "INSERT OR IGNORE INTO mailbox_addresses (address, mailbox_id, can_receive, can_send) VALUES (?, ?, ?, ?)",
      )
      .bind(
        address,
        defaultMailboxId,
        Number(
          address === normalizePersonEmail(receivingAddress ?? "") ||
            (aliases?.split(",").map(normalizePersonEmail).includes(address) ??
              false),
        ),
        Number(address === normalizePersonEmail(sendingAddress ?? "")),
      )
      .run();
  }
};

export const mailboxIdentities = async (db: MailDatabase) => {
  const { results } = await db
    .prepare(
      "SELECT address, can_receive AS canReceive, can_send AS canSend FROM mailbox_addresses WHERE mailbox_id = ? ORDER BY address",
    )
    .bind(db.mailboxId)
    .all<{ address: string; canReceive: number; canSend: number }>();
  return results;
};

export const resolveMailRecipient = async (
  db: D1Database,
  recipient: string,
) => {
  const address = normalizePersonEmail(recipient);
  if (!Schema.is(PersonEmail)(address)) return null;
  // An explicit address reserves its name even when receiving is disabled.
  const exact = await db
    .prepare(
      "SELECT mailbox_id AS mailboxId, can_receive AS canReceive FROM mailbox_addresses WHERE address = ?",
    )
    .bind(address)
    .first<{ mailboxId: string; canReceive: number }>();
  if (exact) return exact.canReceive ? exact.mailboxId : null;
  return (
    (
      await db
        .prepare(
          "SELECT mailbox_id AS mailboxId FROM mail_domain_routes WHERE domain = ?",
        )
        .bind(address.slice(address.lastIndexOf("@") + 1))
        .first<{ mailboxId: string }>()
    )?.mailboxId ?? null
  );
};

// Existing personal-mailbox objects retain their keys and URLs. New mailboxes
// have disjoint prefixes. The root namespace also retains older timestamp keys.
export const mailboxBucket = (
  bucket: R2Bucket,
  mailboxId: string,
): R2Bucket => {
  Schema.decodeUnknownSync(MailboxId)(mailboxId);
  const prefix =
    mailboxId === defaultMailboxId ? "" : `mailboxes/${mailboxId}/`;
  const key = (id: string) => {
    if (!Schema.is(MailMessageId)(id))
      throw new Error("Invalid mail object key");
    return prefix + id;
  };
  const object = <T extends { key: string }>(value: T | null): T | null =>
    value &&
    new Proxy(value, {
      get(target, property) {
        if (property === "key") return target.key.slice(prefix.length);
        const result = Reflect.get(target, property, target);
        return typeof result === "function" ? result.bind(target) : result;
      },
    });
  return new Proxy(bucket, {
    get(target, property) {
      switch (property) {
        case "get":
          return async (id: string, options?: Parameters<R2Bucket["get"]>[1]) =>
            object(await target.get(key(id), options));
        case "head":
          return async (id: string) => object(await target.head(key(id)));
        case "put":
          return async (
            id: string,
            value: Parameters<R2Bucket["put"]>[1],
            options?: Parameters<R2Bucket["put"]>[2],
          ) => object(await target.put(key(id), value, options));
        case "delete":
          return (ids: string | string[]) =>
            target.delete(Array.isArray(ids) ? ids.map(key) : key(ids));
        case "list":
          return async (options?: Parameters<R2Bucket["list"]>[0]) => {
            const page = await target.list({
              ...options,
              prefix,
              delimiter: "/",
            });
            return {
              ...page,
              objects: page.objects
                .filter(
                  (value) =>
                    value.key.startsWith(prefix) &&
                    Schema.is(MailMessageId)(value.key.slice(prefix.length)),
                )
                .map((value) => object(value)!),
            };
          };
        default:
          throw new Error("Unsupported mailbox storage operation");
      }
    },
  });
};

export const scopeMailStore = <
  T extends {
    DB: D1Database;
    INBOX_MESSAGES: R2Bucket;
    SENT_MESSAGES: R2Bucket;
  },
>(
  env: T,
  mailboxId: string,
) => ({
  ...env,
  DB: mailDatabase(env.DB, mailboxId),
  INBOX_MESSAGES: mailboxBucket(env.INBOX_MESSAGES, mailboxId),
  SENT_MESSAGES: mailboxBucket(env.SENT_MESSAGES, mailboxId),
});
