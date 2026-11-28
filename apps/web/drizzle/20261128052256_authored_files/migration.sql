CREATE TABLE `file_objects` (
	`key` text PRIMARY KEY,
	`account_id` text NOT NULL,
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
ALTER TABLE `files` ADD `document_key` text;--> statement-breakpoint
CREATE INDEX `file_objects_owner` ON `file_objects` (`account_id`,`item_id`);--> statement-breakpoint
CREATE INDEX `file_objects_expiration` ON `file_objects` (`expires_at`);