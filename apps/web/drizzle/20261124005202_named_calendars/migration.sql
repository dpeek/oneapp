CREATE TABLE `calendars` (
	`account_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	CONSTRAINT `calendars_pk` PRIMARY KEY(`account_id`, `id`),
	CONSTRAINT `fk_calendars_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `calendar_moved_uids` (
	`account_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`uid` text NOT NULL,
	CONSTRAINT `calendar_moved_uids_pk` PRIMARY KEY(`account_id`, `calendar_id`, `uid`),
	CONSTRAINT `fk_calendar_moved_uids_account_id_calendar_id_calendars_account_id_id_fk` FOREIGN KEY (`account_id`,`calendar_id`) REFERENCES `calendars`(`account_id`,`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `calendars` (`account_id`, `id`, `name`, `name_key`)
SELECT `id`, 'default', 'Personal', 'personal' FROM `accounts`;
--> statement-breakpoint
CREATE TABLE `__new_calendar_events` (
	`id` text PRIMARY KEY,
	`account_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`uid` text NOT NULL,
	`ics` text NOT NULL,
	`revision` text NOT NULL,
	`first_day` text,
	`last_day` text,
	`remind_at` integer,
	`reminder_ends_at` integer,
	`deleted` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_calendar_events_account_id_calendar_id_calendars_account_id_id_fk` FOREIGN KEY (`account_id`,`calendar_id`) REFERENCES `calendars`(`account_id`,`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_calendar_events` (
    `id`, `account_id`, `calendar_id`, `uid`, `ics`, `revision`,
    `first_day`, `last_day`, `remind_at`, `reminder_ends_at`, `deleted`
)
SELECT `id`, `account_id`, 'default', `uid`, `ics`, `revision`,
    `first_day`, `last_day`, `remind_at`, `reminder_ends_at`, `deleted`
FROM `calendar_events`;
--> statement-breakpoint
-- Copy reminder jobs before replacing the event table. Restore them against
-- the final table name so the migration works with foreign keys enabled.
CREATE TABLE `__calendar_push_jobs` AS
SELECT `event_id`, `subscription_id`, `remind_at`, `expires_at`,
    `next_attempt_at`, `attempts`, `lease`, `completed_at`
FROM `calendar_push_outbox`;
--> statement-breakpoint
DROP TABLE `calendar_push_outbox`;
--> statement-breakpoint
DROP TABLE `calendar_events`;
--> statement-breakpoint
ALTER TABLE `__new_calendar_events` RENAME TO `calendar_events`;
--> statement-breakpoint
CREATE TABLE `calendar_push_outbox` (
    `event_id` text NOT NULL,
    `subscription_id` text NOT NULL,
    `remind_at` integer NOT NULL,
    `expires_at` integer NOT NULL,
    `next_attempt_at` integer NOT NULL,
    `attempts` integer DEFAULT 0 NOT NULL,
    `lease` text,
    `completed_at` integer,
    CONSTRAINT `calendar_push_outbox_pk` PRIMARY KEY(`event_id`, `subscription_id`, `remind_at`),
    CONSTRAINT `fk_calendar_push_outbox_event_id_calendar_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `calendar_events`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_calendar_push_outbox_subscription_id_push_subscriptions_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `push_subscriptions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `calendar_push_outbox` (
    `event_id`, `subscription_id`, `remind_at`, `expires_at`,
    `next_attempt_at`, `attempts`, `lease`, `completed_at`
)
SELECT `event_id`, `subscription_id`, `remind_at`, `expires_at`,
    `next_attempt_at`, `attempts`, `lease`, `completed_at`
FROM `__calendar_push_jobs`;
--> statement-breakpoint
DROP TABLE `__calendar_push_jobs`;
--> statement-breakpoint
CREATE INDEX `calendar_push_pending` ON `calendar_push_outbox` (`completed_at`,`next_attempt_at`);
--> statement-breakpoint
CREATE INDEX `calendar_push_expiry` ON `calendar_push_outbox` (`expires_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_event_uid` ON `calendar_events` (`account_id`,`calendar_id`,`uid`);--> statement-breakpoint
CREATE INDEX `calendar_event_reminder` ON `calendar_events` (`remind_at`);--> statement-breakpoint
CREATE INDEX `calendar_event_range` ON `calendar_events` (`account_id`,`deleted`,`first_day`);--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_name` ON `calendars` (`account_id`,`name_key`);
