ALTER TABLE `cli_logins` ADD `can_delete` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `cli_tokens` ADD `can_delete` integer DEFAULT false NOT NULL;