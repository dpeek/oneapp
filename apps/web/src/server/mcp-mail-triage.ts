import type { McpServer } from "@modelcontextprotocol/server";
import { Schema } from "effect";
import type { WorkerEnv } from "../../../../alchemy.run.ts";
import { InboxMessageId, mailMessageLink } from "../inbox-contract.ts";
import { notifyInbox } from "./mail-delivery.ts";
import { setInboxUnread, setThreadArchived } from "./mail-index.ts";
import type { MailDatabase } from "./mailbox.ts";
import { result, runTool, standardSchema, toolFailure } from "./mcp-tool.ts";

const ReadInput = Schema.Struct({
  messageId: InboxMessageId,
  read: Schema.Boolean,
});
const ArchiveInput = Schema.Struct({
  latestIncomingId: InboxMessageId,
  archived: Schema.Boolean,
});
const annotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

type MailStore = Pick<WorkerEnv, "INBOX_UPDATES"> & { DB: MailDatabase };

export const registerMailTriageTools = (
  server: McpServer,
  origin: string,
  ownedMailStore: () => Promise<MailStore>,
  defer: (work: Promise<unknown>) => void,
) => {
  const url = (id: string) => new URL(mailMessageLink(id), origin).href;
  server.registerTool(
    "set_mail_read",
    {
      title: "Set whether an incoming message is read",
      description:
        "Set read to true to mark one incoming message read, or false to mark it unread.",
      inputSchema: standardSchema(ReadInput),
      outputSchema: standardSchema(
        Schema.Struct({ ...ReadInput.fields, url: Schema.String }),
      ),
      annotations,
    },
    ({ messageId, read }) =>
      runTool("Could not change the mail read state.", async () => {
        const store = await ownedMailStore();
        const update = await setInboxUnread(store.DB, messageId, !read);
        if (update === "missing") return toolFailure("Mail message not found.");
        if (update === "changed") defer(notifyInbox(store));
        return result({ messageId, read, url: url(messageId) });
      }),
  );
  server.registerTool(
    "set_mail_archived",
    {
      title: "Archive a conversation or move it back to Inbox",
      description:
        "Set archived to true to archive a conversation, or false to move it back to Inbox. Use the latestIncomingId from search_mail or get_mail_thread after reviewing the conversation. If it has changed, review the new mail before retrying.",
      inputSchema: standardSchema(ArchiveInput),
      outputSchema: standardSchema(
        Schema.Struct({ ...ArchiveInput.fields, url: Schema.String }),
      ),
      annotations,
    },
    ({ latestIncomingId, archived }) =>
      runTool("Could not change the mail archive state.", async () => {
        const store = await ownedMailStore();
        const update = await setThreadArchived(
          store.DB,
          latestIncomingId,
          archived,
          { requireLatest: true },
        );
        if (update === "missing") return toolFailure("Mail message not found.");
        if (update === "stale")
          return toolFailure(
            "Mail triage conflict. Review the newest incoming message before retrying.",
          );
        if (update === "changed") defer(notifyInbox(store));
        return result({
          latestIncomingId,
          archived,
          url: url(latestIncomingId),
        });
      }),
  );
};
