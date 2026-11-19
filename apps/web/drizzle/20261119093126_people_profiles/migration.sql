CREATE TABLE `people` (
	`id` text PRIMARY KEY,
	`account_id` text UNIQUE,
	`name` text DEFAULT '' NOT NULL,
	`photo` text,
	`revision` text NOT NULL,
	CONSTRAINT `fk_people_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `person_addresses` (
	`email` text PRIMARY KEY,
	`person_id` text NOT NULL,
	CONSTRAINT `fk_person_addresses_person_id_people_id_fk` FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `person_addresses_person` ON `person_addresses` (`person_id`);