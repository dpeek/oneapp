ALTER TABLE `calendar_events` ADD COLUMN `first_day` text;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD COLUMN `last_day` text;
--> statement-breakpoint
CREATE INDEX `calendar_event_range` ON `calendar_events` (`account_id`,`deleted`,`first_day`);
