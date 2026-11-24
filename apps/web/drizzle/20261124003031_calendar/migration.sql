CREATE TABLE `calendar_events` (
	`id` text PRIMARY KEY,
	`account_id` text NOT NULL,
	`uid` text NOT NULL,
	`ics` text NOT NULL,
	`revision` text NOT NULL,
	`remind_at` integer,
	`reminder_ends_at` integer,
	`deleted` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_calendar_events_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE
);
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
CREATE UNIQUE INDEX `calendar_event_account_uid` ON `calendar_events` (`account_id`,`uid`);--> statement-breakpoint
CREATE INDEX `calendar_event_reminder` ON `calendar_events` (`remind_at`);--> statement-breakpoint
CREATE INDEX `calendar_push_pending` ON `calendar_push_outbox` (`completed_at`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `calendar_push_expiry` ON `calendar_push_outbox` (`expires_at`);