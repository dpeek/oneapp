CREATE TABLE `cli_tokens` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`label` text NOT NULL,
	`digest` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_cli_tokens_owner_id_accounts_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE INDEX `cli_tokens_owner_created_at` ON `cli_tokens` (`owner_id`,`created_at`);