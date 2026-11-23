import type { ImapFlow } from "imapflow";
import { inventoryErrorMessage } from "./errors.ts";

type InventoryClient = Pick<ImapFlow, "list" | "mailboxOpen" | "fetch">;

export type FolderInventory = {
  path: string;
  specialUse: string | null;
  specialUseSource: string | null;
  selectable: boolean;
  uidValidity?: string;
  uidNext?: number;
  messagesAtOpen?: number;
  messages: number;
  bytes: number;
  unread: number;
  flagged: number;
  deleted: number;
  complete: boolean;
  error?: string;
};

export const inventoryMailbox = async (client: InventoryClient) => {
  const folders: FolderInventory[] = [];
  for (const folder of await client.list()) {
    const row: FolderInventory = {
      path: folder.path,
      specialUse: folder.specialUse ?? null,
      specialUseSource: folder.specialUseSource ?? null,
      selectable: !folder.flags.has("\\Noselect"),
      messages: 0,
      bytes: 0,
      unread: 0,
      flagged: 0,
      deleted: 0,
      complete: true,
    };
    folders.push(row);
    if (!row.selectable) continue;
    try {
      const mailbox = await client.mailboxOpen(folder.path, { readOnly: true });
      // readOnly:true sends EXAMINE. iCloud can return a status which ImapFlow
      // reports as readOnly:false even after EXAMINE succeeds. The command
      // establishes read-only access; the audit only fetches sizes and flags.
      row.uidValidity = String(mailbox.uidValidity);
      row.uidNext = mailbox.uidNext;
      row.messagesAtOpen = mailbox.exists;
      // Bound the scan to the UIDs present when opened. New arrivals belong to
      // the next inventory. Consume the generator before issuing any command.
      if (mailbox.exists && mailbox.uidNext > 1) {
        for await (const message of client.fetch(
          `1:${mailbox.uidNext - 1}`,
          { uid: true, size: true, flags: true },
          { uid: true },
        )) {
          if (message.size === undefined || !message.flags)
            throw Object.assign(new Error(), {
              code: "MissingInventoryMetadata",
            });
          row.messages++;
          row.bytes += message.size;
          row.unread += Number(!message.flags.has("\\Seen"));
          row.flagged += Number(message.flags.has("\\Flagged"));
          row.deleted += Number(message.flags.has("\\Deleted"));
        }
      }
      if (row.messages !== row.messagesAtOpen) {
        row.complete = false;
        row.error =
          "Message count changed during inventory; rerun to reconcile.";
      }
    } catch (error) {
      row.complete = false;
      row.error = `${inventoryErrorMessage(error)} Totals are partial.`;
    }
  }
  return {
    version: 1,
    host: "imap.mail.me.com",
    completedAt: new Date().toISOString(),
    complete: folders.every((folder) => folder.complete),
    messages: folders.reduce((sum, folder) => sum + folder.messages, 0),
    bytes: folders.reduce((sum, folder) => sum + folder.bytes, 0),
    folders,
  };
};
