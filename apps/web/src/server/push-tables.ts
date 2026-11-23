import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { accounts } from "./database.ts";
import { mailboxes } from "./mailbox-tables.ts";

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text().primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id),
    sessionId: text("session_id").notNull(),
    securityRevision: text("security_revision").notNull(),
    endpoint: text().notNull(),
    p256dh: text().notNull(),
    auth: text().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("push_subscription_endpoint").on(table.endpoint),
    index("push_subscription_session").on(table.sessionId),
  ],
);

export const mailPushOutbox = sqliteTable(
  "mail_push_outbox",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id),
    messageId: text("message_id").notNull(),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => pushSubscriptions.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    attempts: integer().notNull().default(0),
    lease: text(),
    completedAt: integer("completed_at"),
  },
  (table) => [
    primaryKey({
      columns: [table.mailboxId, table.messageId, table.subscriptionId],
    }),
    index("mail_push_pending").on(table.completedAt, table.nextAttemptAt),
  ],
);
