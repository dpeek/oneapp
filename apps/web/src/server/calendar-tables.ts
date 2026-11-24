import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { defaultCalendarColor } from "../calendar-contract.ts";
import { accounts } from "./database.ts";
import { pushSubscriptions } from "./push-tables.ts";

export const calendars = sqliteTable(
  "calendars",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    id: text().notNull(),
    name: text().notNull(),
    nameKey: text("name_key").notNull(),
    color: text().notNull().default(defaultCalendarColor),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.id] }),
    uniqueIndex("calendar_name").on(table.accountId, table.nameKey),
  ],
);

export const calendarEvents = sqliteTable(
  "calendar_events",
  {
    id: text().primaryKey(),
    accountId: text("account_id").notNull(),
    calendarId: text("calendar_id").notNull(),
    uid: text().notNull(),
    ics: text().notNull(),
    revision: text().notNull(),
    firstDay: text("first_day"),
    lastDay: text("last_day"),
    remindAt: integer("remind_at"),
    reminderEndsAt: integer("reminder_ends_at"),
    deleted: integer().notNull().default(0),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId, table.calendarId],
      foreignColumns: [calendars.accountId, calendars.id],
    }).onDelete("cascade"),
    uniqueIndex("calendar_event_uid").on(
      table.accountId,
      table.calendarId,
      table.uid,
    ),
    index("calendar_event_reminder").on(table.remindAt),
    index("calendar_event_range").on(
      table.accountId,
      table.deleted,
      table.firstDay,
    ),
  ],
);

// A replay into the former calendar must not recreate an event that moved.
export const calendarMovedUids = sqliteTable(
  "calendar_moved_uids",
  {
    accountId: text("account_id").notNull(),
    calendarId: text("calendar_id").notNull(),
    uid: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.calendarId, table.uid] }),
    foreignKey({
      columns: [table.accountId, table.calendarId],
      foreignColumns: [calendars.accountId, calendars.id],
    }).onDelete("cascade"),
  ],
);

export const calendarPushOutbox = sqliteTable(
  "calendar_push_outbox",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => calendarEvents.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => pushSubscriptions.id, { onDelete: "cascade" }),
    remindAt: integer("remind_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    attempts: integer().notNull().default(0),
    lease: text(),
    completedAt: integer("completed_at"),
  },
  (table) => [
    primaryKey({
      columns: [table.eventId, table.subscriptionId, table.remindAt],
    }),
    index("calendar_push_pending").on(table.completedAt, table.nextAttemptAt),
    index("calendar_push_expiry").on(table.expiresAt),
  ],
);
