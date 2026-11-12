CREATE TABLE `__new_cli_tokens` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`label` text NOT NULL,
	`digest` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	CONSTRAINT `fk_cli_tokens_owner_id_accounts_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_cli_tokens`(`id`, `owner_id`, `label`, `digest`, `created_at`, `expires_at`) SELECT `id`, `owner_id`, `label`, `digest`, `created_at`, `expires_at` FROM `cli_tokens`;--> statement-breakpoint
DROP TABLE `cli_tokens`;--> statement-breakpoint
ALTER TABLE `__new_cli_tokens` RENAME TO `cli_tokens`;--> statement-breakpoint
CREATE TABLE `__new_extension_tokens` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`digest` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	CONSTRAINT `fk_extension_tokens_owner_id_accounts_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_extension_tokens`(`id`, `owner_id`, `digest`, `created_at`, `expires_at`, `revoked_at`) SELECT `id`, `owner_id`, `digest`, `created_at`, `expires_at`, `revoked_at` FROM `extension_tokens`;--> statement-breakpoint
DROP TABLE `extension_tokens`;--> statement-breakpoint
ALTER TABLE `__new_extension_tokens` RENAME TO `extension_tokens`;--> statement-breakpoint
CREATE INDEX `cli_tokens_owner_created_at` ON `cli_tokens` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `extension_tokens_owner` ON `extension_tokens` (`owner_id`);
