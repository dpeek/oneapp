CREATE TABLE `account_email_changes` (
	`subject_id` text PRIMARY KEY,
	`id` text NOT NULL,
	`session_id` text NOT NULL,
	`security_revision` text NOT NULL,
	`new_email` text NOT NULL,
	`digest` text NOT NULL,
	`expires_at` integer NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_account_email_changes_subject_id_accounts_id_fk` FOREIGN KEY (`subject_id`) REFERENCES `accounts`(`id`)
);
