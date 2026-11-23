CREATE TABLE `mail_imports` (
	`source_id` text PRIMARY KEY,
	`message_id` text NOT NULL,
	`sha256` text NOT NULL,
	`metadata` text NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_imports_message` ON `mail_imports` (`message_id`);