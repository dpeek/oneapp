CREATE TABLE `company_domains` (
	`domain` text PRIMARY KEY,
	`company_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_company_domains_company_id_people_id_fk` FOREIGN KEY (`company_id`) REFERENCES `people`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `people` ADD `kind` text DEFAULT 'person' NOT NULL;--> statement-breakpoint
CREATE INDEX `company_domains_company` ON `company_domains` (`company_id`);