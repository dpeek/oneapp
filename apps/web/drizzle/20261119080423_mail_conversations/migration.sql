CREATE TABLE `mail_index_keys` (
	`identity` text PRIMARY KEY,
	`thread_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mail_index_messages` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`folder` text NOT NULL,
	`sender` text NOT NULL,
	`recipient` text NOT NULL,
	`subject` text NOT NULL,
	`timestamp` integer NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mail_index_scans` (
	`folder` text PRIMARY KEY,
	`cursor` text,
	`scanned_at` integer NOT NULL,
	`ready` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mail_index_keys_thread` ON `mail_index_keys` (`thread_id`);--> statement-breakpoint
CREATE INDEX `mail_index_folder_date` ON `mail_index_messages` (`folder`,`deleted`,`timestamp`,`id`);--> statement-breakpoint
CREATE INDEX `mail_index_thread_folder_date` ON `mail_index_messages` (`thread_id`,`folder`,`deleted`,`timestamp`,`id`);