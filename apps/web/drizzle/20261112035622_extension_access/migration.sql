CREATE TABLE `extension_tokens` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`digest` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	CONSTRAINT `fk_extension_tokens_owner_id_accounts_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE INDEX `extension_tokens_owner` ON `extension_tokens` (`owner_id`);