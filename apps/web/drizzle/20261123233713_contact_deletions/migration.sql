CREATE TABLE `contact_deletions` (
	`id` text PRIMARY KEY,
	`receipt` text NOT NULL UNIQUE,
	`revision` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`photo` text,
	`addresses` text NOT NULL,
	`domains` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `contact_deletions_expiry` ON `contact_deletions` (`expires_at`);