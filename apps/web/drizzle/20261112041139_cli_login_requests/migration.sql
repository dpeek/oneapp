CREATE TABLE `cli_logins` (
	`id` text PRIMARY KEY,
	`digest` text NOT NULL UNIQUE,
	`code` text NOT NULL,
	`label` text NOT NULL,
	`expires_at` integer NOT NULL,
	`owner_id` text,
	`denied_at` integer,
	`redeemed_at` integer,
	CONSTRAINT `fk_cli_logins_owner_id_accounts_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE INDEX `cli_logins_expires_at` ON `cli_logins` (`expires_at`);