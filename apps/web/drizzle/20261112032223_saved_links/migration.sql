CREATE TABLE `links` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`url` text NOT NULL,
	`saved_at` integer NOT NULL,
	CONSTRAINT `fk_links_owner_id_accounts_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE INDEX `links_owner_saved_at` ON `links` (`owner_id`,`saved_at`,`id`);