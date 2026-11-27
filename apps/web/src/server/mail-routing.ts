import type { D1Database } from "@cloudflare/workers-types";
import { defaultMailboxId, ensureDefaultMailbox } from "./mailbox.ts";

export const primaryMailDomain = "dpeek.com";
export const exactMailDomain = "orumai.app";
export const primaryMailAddress = `mail@${primaryMailDomain}`;

export const seedMailRoutes = async (db: D1Database) => {
  await ensureDefaultMailbox(db);
  const setAddress = (address: string, canSend: number) =>
    db
      .prepare(
        `INSERT INTO mailbox_addresses (address, mailbox_id, can_receive, can_send)
         VALUES (?, ?, 1, ?)
         ON CONFLICT (address) DO UPDATE SET
           mailbox_id = excluded.mailbox_id, can_receive = excluded.can_receive,
           can_send = excluded.can_send`,
      )
      .bind(address, defaultMailboxId, canSend);
  await db.batch([
    setAddress(primaryMailAddress, 1),
    ...["support", "team", "admin"].map((name) =>
      setAddress(`${name}@${exactMailDomain}`, 0),
    ),
    db
      .prepare(
        `INSERT INTO mail_domain_routes (domain, mailbox_id) VALUES (?, ?)
         ON CONFLICT (domain) DO UPDATE SET mailbox_id = excluded.mailbox_id`,
      )
      .bind(primaryMailDomain, defaultMailboxId),
    db
      .prepare("DELETE FROM mail_domain_routes WHERE domain = ?")
      .bind(exactMailDomain),
  ]);
};
